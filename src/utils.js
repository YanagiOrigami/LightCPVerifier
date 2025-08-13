import fs from 'fs/promises';
import path from 'path';

// 清空目录
export async function emptyDir(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        await fs.rm(fullPath, { recursive: true, force: true });
    }
}

// 时间单位转换
export function toNs(s) {
    if (typeof s === 'number') return s;
    const m = String(s).match(/^([\d.]+)\s*(ms|s)?$/i);
    const v = parseFloat(m?.[1] ?? '0'); 
    const u = (m?.[2] || 's').toLowerCase();
    return Math.round(v * (u === 'ms' ? 1e6 : 1e9));
}

// 内存单位转换
export function toBytes(s) {
    if (typeof s === 'number') return s;
    const m = String(s).match(/^([\d.]+)\s*(k|m|g|)$|^([\d.]+)$/i);
    const v = parseFloat(m?.[1] ?? m?.[3] ?? '0'); 
    const u = (m?.[2] || '').toLowerCase();
    const mul = u === 'g' ? 1 << 30 : u === 'm' ? 1 << 20 : u === 'k' ? 1 << 10 : 1;
    return Math.round(v * mul);
}

export async function dirExists(pdir) {
  try {
    await fs.access(pdir);
    return true;              // 能访问 -> 存在
  } catch (e) {
    if (e && e.code === 'ENOENT') return false; // 不存在
    throw e;                  // 其他 IO 错误上抛（交给统一错误处理中间件）
  }
}

export async function fileExists(filePath) {
    try {
        await fs.stat(filePath);
        return true;
    } catch {
        return false;
    }
}

export async function ensureDir(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
    }
}

export async function parseProblemConf(confPath) {
    const content = await fs.readFile(confPath, 'utf8');
    const lines = content.split('\n');
    const conf = {};
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        
        const [key, ...valueParts] = trimmed.split(/\s+/);
        const value = valueParts.join(' ');
        
        if (key && value) {
            conf[key.toLowerCase()] = value;
        }
    }
    
    return conf;
}

export async function findTestCases(dir) {
        const files = await fs.readdir(dir);
        const testCases = new Map();
        
        //testing.
        //throw new Error('The test cases:' + JSON.stringify(files));
        // 查找所有 .in 文件
        for (const file of files) {
            if (file.endsWith('.in')) {
                const baseName = file.slice(0, -3);
                testCases.set(baseName, { input: file, output: null });
            }
        }
        
        // 查找对应的 .ans 或 .out 文件
        for (const file of files) {
            if (file.endsWith('.ans') || file.endsWith('.out')) {
                const baseName = file.endsWith('.ans') ? file.slice(0, -4) : file.slice(0, -4);
                if (testCases.has(baseName)) {
                    testCases.get(baseName).output = file;
                }
            }
        }
        
        // 过滤出完整的测试用例对
        const validCases = [];
        for (const [baseName, caseFiles] of testCases) {
            if (caseFiles.input && caseFiles.output) {
                validCases.push({
                    baseName,
                    input: caseFiles.input,
                    output: caseFiles.output
                });
            }
        }
        
        // 按字典序排序
        validCases.sort((a, b) => a.baseName.localeCompare(b.baseName));
        
        //testing.
        //throw new Error('The test cases:' + JSON.stringify(validCases));

        return validCases;
    }

// 提交ID生成和路径管理
export class SubmissionManager {
    constructor(dataRoot, submissionsRoot, bucketSize = 100) {
        this.dataRoot = dataRoot;
        this.submissionsRoot = submissionsRoot;
        this.bucketSize = bucketSize;
        this.counterFile = path.join(dataRoot, 'counter.txt');
    }

    async nextSubmissionId() {
        let n = 0;
        try { 
            n = parseInt((await fs.readFile(this.counterFile, 'utf8')).trim(), 10) || 0; 
        } catch { }
        const next = n + 1;
        await fs.writeFile(this.counterFile, String(next));
        return next;
    }

    submissionPaths(sid) {
        const bucketPrefix = Math.floor(sid / this.bucketSize) * this.bucketSize;
        const bucketDir = path.join(this.submissionsRoot, String(bucketPrefix));
        const subDir = path.join(bucketDir, String(sid));
        return { bucketDir, subDir };
    }

    async resetCounter() {
        await fs.writeFile(this.counterFile, '0');
    }
}