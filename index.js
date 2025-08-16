import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'js-yaml';
import axios from 'axios';
import tar from 'tar';
import { pipeline } from 'stream/promises';

async function emptyDir(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        await fs.rm(fullPath, { recursive: true, force: true });
    }
}

const app = express();
app.use(express.json({ limit: '10mb' }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const problemsRoot = path.join(__dirname, 'problems');
const dataRoot = path.join(__dirname, 'data');
const submissionsRoot = process.env.SUBMISSIONS_DIR || path.join(__dirname, 'submissions');

const BUCKET_SIZE = +(process.env.SUB_BUCKET || 100);
const GJ = process.env.GJ_ADDR || 'http://127.0.0.1:5050';
const WORKERS = +(process.env.JUDGE_WORKERS || 4);

// testlib 在容器内可见的目录（通过 go-judge 的 mount.yaml 绑定到容器）
const TESTLIB_INSIDE = process.env.TESTLIB_INSIDE || '/lib/testlib';

await fs.mkdir(dataRoot, { recursive: true });
await fs.mkdir(submissionsRoot, { recursive: true });

// 内存队列与结果
const queue = [];
const results = new Map();

// 计数器
const COUNTER_FILE = path.join(dataRoot, 'counter.txt');
async function nextSubmissionId() {
    let n = 0;
    try { n = parseInt((await fs.readFile(COUNTER_FILE, 'utf8')).trim(), 10) || 0; } catch { }
    const next = n + 1;
    await fs.writeFile(COUNTER_FILE, String(next));
    return next;
}
function submissionPaths(sid) {
    const bucketPrefix = Math.floor(sid / BUCKET_SIZE) * BUCKET_SIZE;
    const bucketDir = path.join(submissionsRoot, String(bucketPrefix));
    const subDir = path.join(bucketDir, String(sid));
    return { bucketDir, subDir };
}

// 工具：单位
function toNs(s) {
    if (typeof s === 'number') return s;
    const m = String(s).match(/^([\d.]+)\s*(ms|s)?$/i);
    const v = parseFloat(m?.[1] ?? '0'); const u = (m?.[2] || 's').toLowerCase();
    return Math.round(v * (u === 'ms' ? 1e6 : 1e9));
}
function toBytes(s) {
    if (typeof s === 'number') return s;
    const m = String(s).match(/^([\d.]+)\s*(k|m|g|)$|^([\d.]+)$/i);
    const v = parseFloat(m?.[1] ?? m?.[3] ?? '0'); const u = (m?.[2] || '').toLowerCase();
    const mul = u === 'g' ? 1 << 30 : u === 'm' ? 1 << 20 : u === 'k' ? 1 << 10 : 1;
    return Math.round(v * mul);
}

// go-judge 基础调用
async function gjRunOne(cmd) {
    const { data } = await axios.post(`${GJ}/run`, { cmd: [cmd] }, { timeout: 300000 });
    return data[0];
}
async function gjDeleteFile(fileId) {
    try { await axios.delete(`${GJ}/file/${encodeURIComponent(fileId)}`); } catch { }
}

// ---------- 基于 go-judge 的编译 / 预留文件 ----------
async function cacheSingleFile(name, content) {
    // 通过一次 /run 把文件写入容器并 copyOutCached 回文件ID
    const res = await gjRunOne({
        args: ['/bin/true'],
        env: ['PATH=/usr/bin:/bin'],
        files: [{ content: '' }, { name: 'stdout', max: 1 }, { name: 'stderr', max: 1024 }],
        copyIn: { [name]: { content } },
        copyOutCached: [name],
        cpuLimit: 1e9, memoryLimit: 16 << 20, procLimit: 5,
    });
    if (res.status !== 'Accepted' || !res.fileIds?.[name]) throw new Error(`cache file failed: ${res.status}`);
    return res.fileIds[name];
}

// 语言相关：在沙箱内“编译或准备”并返回 { runArgs, preparedCopyIn, cleanupIds[] }
async function prepareProgramInSandbox({ lang, code, mainName = null }) {
    if (lang === 'cpp') {
        const srcName = mainName || 'main.cpp';
        const outName = 'a';
        const res = await gjRunOne({
            args: ['/usr/bin/g++', srcName, '-O2', '-pipe', '-std=gnu++17', '-o', outName],
            env: ['PATH=/usr/bin:/bin'],
            files: [{ content: '' }, { name: 'stdout', max: 1024 * 1024 }, { name: 'stderr', max: 1024 * 1024 }],
            copyIn: { [srcName]: { content: code } },
            copyOut: ['stdout', 'stderr'],
            copyOutCached: [outName],
            cpuLimit: 10e9, memoryLimit: 512 << 20, procLimit: 50,
        });
        if (res.status !== 'Accepted') throw new Error(`compile failed: ${res.files?.stderr || res.status}`);
        const exeId = res.fileIds[outName];
        return { runArgs: [outName], preparedCopyIn: { [outName]: { fileId: exeId } }, cleanupIds: [exeId] };
    }

    if (lang === 'java') {
        const srcName = mainName || 'Main.java';
        const mainClass = (srcName.replace(/\.java$/, '') || 'Main');
        const res = await gjRunOne({
            args: ['/usr/bin/javac', srcName],
            env: ['PATH=/usr/bin:/bin'],
            files: [{ content: '' }, { name: 'stdout', max: 1024 * 64 }, { name: 'stderr', max: 1024 * 64 }],
            copyIn: { [srcName]: { content: code } },
            copyOut: ['stdout', 'stderr'],
            copyOutCached: [`${mainClass}.class`],
            cpuLimit: 10e9, memoryLimit: 1024 << 20, procLimit: 50,
        });
        if (res.status !== 'Accepted') throw new Error(`javac failed: ${res.files?.stderr || res.status}`);
        const clsId = res.fileIds[`${mainClass}.class`];
        return {
            runArgs: ['/usr/bin/java', mainClass],
            preparedCopyIn: { [`${mainClass}.class`]: { fileId: clsId } },
            cleanupIds: [clsId],
        };
    }

    if (lang === 'py' || lang === 'pypy' || lang === 'python' || lang === 'python3') {
        const srcName = mainName || 'main.py';
        const fileId = await cacheSingleFile(srcName, code);
        const interp = (lang === 'pypy') ? '/usr/bin/pypy3' : '/usr/bin/python3';
        return { runArgs: [interp, srcName], preparedCopyIn: { [srcName]: { fileId } }, cleanupIds: [fileId] };
    }

    throw new Error('unsupported lang');
}

// 在沙箱内编译 testlib checker，返回 {checkerId, cleanup()}
async function prepareCheckerInSandbox({ checkerSourceText }) {
    const srcName = 'chk.cc';
    const outName = 'chk';
    const res = await gjRunOne({
        args: ['/usr/bin/g++', srcName, '-O2', '-pipe', '-std=gnu++17', '-I', TESTLIB_INSIDE, '-o', outName],
        env: ['PATH=/usr/bin:/bin'],
        files: [{ content: '' }, { name: 'stdout', max: 1024 * 64 }, { name: 'stderr', max: 1024 * 64 }],
        copyIn: { [srcName]: { content: checkerSourceText } },
        copyOutCached: [outName],
        cpuLimit: 10e9, memoryLimit: 512 << 20, procLimit: 50,
    });
    if (res.status !== 'Accepted') throw new Error(`checker compile failed: ${res.files?.stderr || res.status}`);
    const checkerId = res.fileIds[outName];
    return {
        checkerId,
        async cleanup() { await gjDeleteFile(checkerId); }
    };
}

// ---------- 题目加载 ----------
async function loadProblem(pid) {
    const pdir = path.join(problemsRoot, pid);
    const cfgPath = path.join(pdir, 'config.yaml');
    const cfg = YAML.load(await fs.readFile(cfgPath, 'utf8'));
    if ((cfg.type || 'default') !== 'default') throw new Error('Only type=default supported');

    if (!(cfg.subtasks && Array.isArray(cfg.subtasks))) {
        throw new Error('config.yaml must define subtasks.cases');
    }
    const cases = [];
    cfg.subtasks.forEach((st, si) => {
        st.cases.forEach(c => cases.push({
            subtask: si,
            input: c.input, output: c.output,
            time: (c.time || st.time || cfg.time || '1s'),
            memory: (c.memory || st.memory || cfg.memory || '256m')
        }));
    });
    const checker = cfg.checker || 'chk.cc';
    const filename = cfg.filename || null;
    return { pdir, cfg, cases, checker, filename };
}

// ---------- 判题单个测试点（全程沙箱） ----------
async function judgeCase({ runSpec, caseItem, p, checkerId }) {
    const inf = await fs.readFile(path.join(p.pdir, 'testdata', caseItem.input), 'utf8');
    const ansf = await fs.readFile(path.join(p.pdir, 'testdata', caseItem.output.replace(/\.out$/, '.ans'))).catch(() => null);
    const ans = ansf ? ansf.toString() : await fs.readFile(path.join(p.pdir, 'testdata', caseItem.output), 'utf8');

    // 选手程序运行
    const runRes = await gjRunOne({
        args: runSpec.runArgs,
        env: ['PATH=/usr/bin:/bin'],
        files: [{ content: inf }, { name: 'stdout', max: 1024 * 1024 * 1024 }, { name: 'stderr', max: 1024 * 1024 }],
        cpuLimit: toNs(caseItem.time),
        clockLimit: toNs(caseItem.time) * 2,
        memoryLimit: toBytes(caseItem.memory),
        procLimit: 50,
        copyIn: { ...runSpec.preparedCopyIn }
    });
    if (runRes.status !== 'Accepted') {
        return { ok: false, status: runRes.status, time: runRes.runTime, memory: runRes.memory, msg: runRes.files?.stderr || '' };
    }
    const out = runRes.files?.stdout ?? '';

    // checker（testlib）运行：chk in.txt out.txt ans.txt
    const chkRes = await gjRunOne({
        args: ['chk', 'in.txt', 'out.txt', 'ans.txt'],
        env: ['PATH=/usr/bin:/bin'],
        files: [{ content: '' }, { name: 'stdout', max: 1024 * 1024 }, { name: 'stderr', max: 1024 * 1024 }],
        cpuLimit: 2e9, memoryLimit: 256 << 20, procLimit: 10,
        copyIn: {
            'chk': { fileId: checkerId },
            'in.txt': { content: inf },
            'out.txt': { content: out },
            'ans.txt': { content: ans }
        }
    });
    const ok = chkRes.status === 'Accepted' && chkRes.exitStatus === 0;
    return {
        ok,
        status: ok ? 'Accepted' : 'Wrong Answer',
        time: runRes.runTime,
        memory: runRes.memory,
        msg: chkRes.files?.stdout || chkRes.files?.stderr || ''
    };
}

// ---------- worker ----------
for (let i = 0; i < WORKERS; i++) (async function worker() {
    for (; ;) {
        const job = queue.shift();
        if (!job) { await new Promise(r => setTimeout(r, 50)); continue; }

        const { sid, pid, lang, code } = job;
        //const workDir = path.join(dataRoot, String(sid));
        const { bucketDir, subDir } = submissionPaths(sid);
        //await fs.mkdir(workDir, { recursive: true });
        await fs.mkdir(bucketDir, { recursive: true });
        await fs.mkdir(subDir, { recursive: true });

        let cleanupIds = [];
        let checkerCleanup = null;

        try {
            const p = await loadProblem(pid);

            // 归档源码
            const srcName =
                lang === 'cpp' ? 'main.cpp' :
                    (lang === 'py' || lang === 'pypy') ? 'main.py' :
                        lang === 'java' ? 'Main.java' : 'main.txt';
            await fs.writeFile(path.join(subDir, srcName), code);

            // 准备选手程序（沙箱内编译/缓存）
            const runSpec = await prepareProgramInSandbox({ lang, code, mainName: p.filename || null });
            cleanupIds.push(...(runSpec.cleanupIds || []));

            // 编译 checker（沙箱内）
            const chkSrc = await fs.readFile(path.join(p.pdir, p.checker), 'utf8');
            const { checkerId, cleanup } = await prepareCheckerInSandbox({ checkerSourceText: chkSrc });
            checkerCleanup = cleanup;

            // 逐测试点（遇到非 AC 早停）
            const caseResults = [];
            let firstBad = null;
            for (const c of p.cases) {
                const r = await judgeCase({ runSpec, caseItem: c, p, checkerId });
                caseResults.push(r);
                if (!r.ok) { firstBad = r; break; }
            }
            const passed = firstBad === null;

            const final = { status: 'done', passed, cases: caseResults };
            results.set(sid, final);
            await fs.writeFile(path.join(subDir, 'result.json'), JSON.stringify(final, null, 2));
        } catch (e) {
            const err = { status: 'error', error: String(e) };
            results.set(sid, err);
            await fs.writeFile(path.join(subDir, 'result.json'), JSON.stringify(err, null, 2));
        } finally {
            // 清理 go-judge 缓存文件
            for (const id of cleanupIds) await gjDeleteFile(id);
            if (checkerCleanup) await checkerCleanup();
            // 可选：清理工作目录
            // await fs.rm(workDir, { recursive: true, force: true });
        }
    }
})();

// ---------- API ----------
app.post('/submit', async (req, res) => {
    const { pid, lang, code } = req.body || {};
    if (!pid || !lang || !code) return res.status(400).json({ error: 'pid/lang/code required' });

    const sid = await nextSubmissionId();
    results.set(sid, { status: 'queued' });
    queue.push({ sid, pid, lang, code });

    const { bucketDir, subDir } = submissionPaths(sid);
    await fs.mkdir(bucketDir, { recursive: true });
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, 'meta.json'), JSON.stringify({ sid, pid, lang, ts: Date.now() }, null, 2));

    res.json({ sid });
});

app.get('/result/:sid', async (req, res) => {
    const sid = parseInt(req.params.sid, 10);
    if (Number.isNaN(sid)) return res.status(400).json({ error: 'sid must be number' });

    const r = results.get(sid);
    if (r) {
        const result = res.json(r);
        results.delete(sid); // 确保响应发送后再删除
        return result;
    }

    try {
        const { subDir } = submissionPaths(sid);
        const txt = await fs.readFile(path.join(subDir, 'result.json'), 'utf8');
        return res.json(JSON.parse(txt));
    } catch {
        return res.status(404).json({ error: 'not found' });
    }
});

// 题面
app.get('/problem/:pid/statement', async (req, res) => {
    try {
        const fp = path.join(problemsRoot, req.params.pid, 'statement.txt');
        const txt = await fs.readFile(fp, 'utf8');
        res.type('text/plain').send(txt);
    } catch {
        res.status(404).send('statement not found');
    }
});

app.get('/health', (_, res) => res.json({ ok: true }));
app.listen(process.env.PORT || 8081, () => console.log('LightCPVerifier listening (sandbox-first)'));


// 功能1: 获取所有题目列表
app.get('/problems', async (req, res) => {
    try {
        const includeStatement = req.query.statement === 'true';
        const problems = [];

        // 读取 problems 目录下的所有文件夹
        const folders = await fs.readdir(problemsRoot, { withFileTypes: true });
        const problemFolders = folders
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name)
            .sort(); // 字典序排列

        for (const folder of problemFolders) {
            const problemPath = path.join(problemsRoot, folder);
            const configPath = path.join(problemPath, 'config.yaml');

            try {
                // 检查是否存在 config.yaml
                await fs.access(configPath);

                const problemInfo = {
                    id: folder
                };

                // 如果需要包含 statement
                if (includeStatement) {
                    try {
                        const statementPath = path.join(problemPath, 'statement.txt');
                        const statement = await fs.readFile(statementPath, 'utf8');
                        problemInfo.statement = statement;
                    } catch {
                        // statement 文件不存在，不添加该字段
                    }
                }

                problems.push(problemInfo);
            } catch {
                // config.yaml 不存在，跳过该文件夹
            }
        }

        res.json({ problems });
    } catch (error) {
        res.status(500).json({ error: 'Failed to list problems', message: error.message });
    }
});

app.get('/submissions/export', async (req, res) => {
    try {
        await fs.access(submissionsRoot);
        
        // 设置响应头
        res.setHeader('Content-Type', 'application/gzip');
        res.setHeader('Content-Disposition', `attachment; filename=submissions_${Date.now()}.tar.gz`);
        
        // 直接创建 tar 流并管道到响应
        tar.c(
            {
                gzip: true,
                cwd: submissionsRoot
            },
            ['.']
        ).pipe(res);
        
    } catch (error) {
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to export submissions', message: error.message });
        }
    }
});

// 功能2: 打包下载并重置 submissions
app.post('/submissions/reset', async (req, res) => {
    try {
        // 清空 submissions 目录
        await emptyDir(submissionsRoot);
        //await emptyDir(dataRoot);
        // 重置 counter
        await fs.writeFile(COUNTER_FILE, '0');
        
        // 清空内存中的结果缓存
        results.clear();
        
        res.json({
            success: true,
            message: 'Submissions reset successfully'
        });
        
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to reset submissions', 
            message: error.message 
        });
    }
});