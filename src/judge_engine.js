import fs from 'fs/promises';
import path from 'path';
import { toNs, toBytes, fileExists } from './utils.js';
import { GoJudgeClient } from './gojudge.js';
import { ProblemManager } from './problem_manager.js';

export class JudgeEngine {
    constructor(config) {
        this.problemManager = new ProblemManager({
            problemsRoot: config.problemsRoot,
            gjAddr: config.gjAddr,
            testlibPath: config.testlibPath
        });
        this.goJudge = new GoJudgeClient(config.gjAddr);
        this.submissionManager = config.submissionManager;
        this.testlibPath = config.testlibPath || '/lib/testlib';
        
        // 内存队列与结果
        this.queue = [];
        this.results = new Map();
        
        // 启动工作线程
        this.startWorkers(config.workers || 4);
    }

    // 提交任务
    async submit(pid, lang, code) {
        const sid = await this.submissionManager.nextSubmissionId();
        this.results.set(sid, { status: 'queued' });
        const { bucketDir, subDir } = this.submissionManager.submissionPaths(sid);
        await fs.mkdir(bucketDir, { recursive: true });
        await fs.mkdir(subDir, { recursive: true });

        if(this.queue.length >= 1024 * 512){
            this.queue.push({ sid, pid, lang });
            await fs.writeFile(
                path.join(subDir, `source.code`),
                code
            );
        }else{
            this.queue.push({ sid, pid, lang, code });
        }

        await fs.writeFile(
            path.join(subDir, 'meta.json'), 
            JSON.stringify({ sid, pid, lang, ts: Date.now() }, null, 2)
        );

        return sid;
    }

    // 获取结果
    async getResult(sid) {
        const r = this.results.get(sid);
        if (r) {
            this.results.delete(sid);
            return r;
        }

        try {
            const { subDir } = this.submissionManager.submissionPaths(sid);
            const txt = await fs.readFile(path.join(subDir, 'result.json'), 'utf8');
            return JSON.parse(txt);
        } catch {
            return null;
        }
    }

    // 清空结果缓存
    clearResults() {
        this.results.clear();
    }

    // 判题单个测试点
    async judgeCase({ runSpec, caseItem, problem, checkerId }) {
        // 读取输入输出文件
        const inf = await this.problemManager.readTestFile(problem.pdir.split('/').pop(), caseItem.input);
        
        let ans;
        try {
            // 尝试读取 .ans 文件
            const ansFile = caseItem.output.replace(/\.out$/, '.ans');
            ans = await this.problemManager.readTestFile(problem.pdir.split('/').pop(), ansFile);
        } catch {
            // 如果没有 .ans 文件，读取 .out 文件
            ans = await this.problemManager.readTestFile(problem.pdir.split('/').pop(), caseItem.output);
        }

        // 选手程序运行
        const runRes = await this.goJudge.runOne({
            args: runSpec.runArgs,
            env: ['PATH=/usr/bin:/bin'],
            files: [{ content: inf }, { name: 'stdout', max: 128 * 1024 * 1024 }, { name: 'stderr', max: 1024 * 1024 }],
            cpuLimit: toNs(caseItem.time),
            clockLimit: toNs(caseItem.time) * 2,
            memoryLimit: toBytes(caseItem.memory),
            procLimit: 50,
            copyIn: { ...runSpec.preparedCopyIn }
        });

        if (runRes.status !== 'Accepted') {
            return { 
                ok: false, 
                status: runRes.status, 
                time: runRes.runTime, 
                memory: runRes.memory, 
                msg: runRes.files?.stderr || '' 
            };
        }

        const out = runRes.files?.stdout ?? '';
        
        // checker（testlib）运行：chk in.txt out.txt ans.txt
        const chkRes = await this.goJudge.runOne({
            args: ['chk', 'in.txt', 'out.txt', 'ans.txt'],
            env: ['PATH=/usr/bin:/bin'],
            files: [{ content: '' }, { name: 'stdout', max: 1024 * 1024 }, { name: 'stderr', max: 1024 * 1024 }],
            cpuLimit: 2e9,
            clockLimit: 4e9,
            memoryLimit: 256 << 20, 
            procLimit: 10,
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

    // 启动工作线程
    startWorkers(workerCount) {
        for (let i = 0; i < workerCount; i++) {
            this.startWorker();
        }
    }

    // 单个工作线程
    async startWorker() {
        while (true) {
            const job = this.queue.shift();
            if (!job) { 
                await new Promise(r => setTimeout(r, 50)); 
                continue; 
            }

            let { sid, pid, lang, code } = job;
            const { bucketDir, subDir } = this.submissionManager.submissionPaths(sid);
            if(code === null){
                code = await fs.readFile(path.join(subDir, `source.code`), 'utf8');
            }else{
                await fs.writeFile(path.join(subDir, `source.code`), code);
            }
            

            let cleanupIds = [];
            let checkerCleanup = null;

            try {
                const problem = await this.problemManager.loadProblem(pid);

                // 归档源码
                //const srcName = this.getSourceFileName(lang);
                //await fs.writeFile(path.join(subDir, srcName), code);

                // 准备选手程序（沙箱内编译/缓存）
                const runSpec = await this.goJudge.prepareProgram({ 
                    lang, 
                    code, 
                    mainName: problem.filename || null 
                });
                cleanupIds.push(...(runSpec.cleanupIds || []));

                
                // 读取 checker.bin 文件（如果存在）
                const checkerBinPath = path.join(problem.pdir, `${problem.checker}.bin`);
                let checkerResult;
                if (await fileExists(checkerBinPath)) {
                    checkerResult = await this.goJudge.copyInChecker(checkerBinPath);
                } else if (problem.checker) {
                    // 否则读取 checker 源码并编译
                    const chkSrc = await this.problemManager.readCheckerSource(pid, problem.checker);
                    checkerResult = await this.goJudge.prepareChecker(chkSrc, this.testlibPath);
                }
                const { checkerId, cleanup } = checkerResult;
                checkerCleanup = cleanup;

                // 逐测试点（遇到非 AC 早停）
                const caseResults = [];
                let firstBad = null;
                for (const c of problem.cases) {
                    const r = await this.judgeCase({ runSpec, caseItem: c, problem, checkerId });
                    caseResults.push(r);
                    if (!r.ok) { 
                        firstBad = r; 
                        break; 
                    }
                }
                const passed = firstBad === null;
                const result = caseResults[caseResults.length - 1].status || 'Unknown';

                const final = { status: 'done', passed, result, cases: caseResults };
                this.results.set(sid, final);
                await fs.writeFile(path.join(subDir, 'result.json'), JSON.stringify(final, null, 2));
            } catch (e) {
                const err = { status: 'error', error: String(e) };
                this.results.set(sid, err);
                await fs.writeFile(path.join(subDir, 'result.json'), JSON.stringify(err, null, 2));
            } finally {
                // 清理 go-judge 缓存文件
                for (const id of cleanupIds) {
                    await this.goJudge.deleteFile(id);
                }
                if (checkerCleanup) {
                    await checkerCleanup();
                }
            }
        }
    }

    // 根据语言获取源文件名
    getSourceFileName(lang) {
        switch (lang) {
            case 'cpp': return 'main.cpp';
            case 'py':
            case 'pypy': return 'main.py';
            case 'java': return 'Main.java';
            default: return 'main.txt';
        }
    }
}