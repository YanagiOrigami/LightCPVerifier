import fs from 'fs/promises';
import path from 'path';
import YAML from 'js-yaml';
import unzipper from 'unzipper';

import { dirExists } from './utils.js';

export class ProblemManager {
    constructor(problemsRoot) {
        this.problemsRoot = problemsRoot;
    }

    // 加载单个题目
    async loadProblem(pid) {
        const pdir = path.join(this.problemsRoot, pid);
        const cfgPath = path.join(pdir, 'config.yaml');
        
        const cfg = YAML.load(await fs.readFile(cfgPath, 'utf8'));
        if ((cfg.type || 'default') !== 'default') {
            throw new Error('Only type=default supported');
        }

        if (!(cfg.subtasks && Array.isArray(cfg.subtasks))) {
            throw new Error('config.yaml must define subtasks.cases');
        }

        const cases = [];
        cfg.subtasks.forEach((st, si) => {
            st.cases.forEach(c => cases.push({
                subtask: si,
                input: c.input, 
                output: c.output,
                time: (c.time || st.time || cfg.time || '1s'),
                memory: (c.memory || st.memory || cfg.memory || '256m')
            }));
        });

        const checker = cfg.checker || 'chk.cc';
        const filename = cfg.filename || null;
        
        return { pdir, cfg, cases, checker, filename };
    }

    // 获取题面
    async getStatement(pid) {
        const fp = path.join(this.problemsRoot, pid, 'statement.txt');
        return await fs.readFile(fp, 'utf8');
    }

    // 获取所有题目列表
    async listProblems(includeStatement = false) {
        const problems = [];
        
        const folders = await fs.readdir(this.problemsRoot, { withFileTypes: true });
        const problemFolders = folders
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name)
            .sort();

        for (const folder of problemFolders) {
            const problemPath = path.join(this.problemsRoot, folder);
            const configPath = path.join(problemPath, 'config.yaml');

            try {
                // 检查是否存在 config.yaml
                await fs.access(configPath);

                const problemInfo = { id: folder };

                // 如果需要包含 statement
                if (includeStatement) {
                    try {
                        const statement = await this.getStatement(folder);
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

        return problems;
    }

    // 读取测试数据文件
    async readTestFile(pid, filename) {
        const filePath = path.join(this.problemsRoot, pid, 'testdata', filename);
        return await fs.readFile(filePath, 'utf8');
    }

    // 读取 checker 源码
    async readCheckerSource(pid, checkerFile = 'chk.cc') {
        const filePath = path.join(this.problemsRoot, pid, checkerFile);
        return await fs.readFile(filePath, 'utf8');
    }

    async setupProblem(pid, zipfile) {
        const pdir = path.join(this.problemsRoot, pid);
        if (!await dirExists(pdir)) {
            throw new Error(`Problem ${pid} does not exist`);
        }

        if (!zipfile) {
            throw new Error('No zip file provided');
        }

        const testdataDir = path.join(pdir, 'testdata');
        
        // 确保 testdata 目录存在
        await fs.mkdir(testdataDir, { recursive: true });

        if (typeof zipfile === 'string') {
            // 处理字符串路径
            const zipPath = path.resolve(zipfile);
            if (!await dirExists(zipPath)) {
                throw new Error(`Zip file ${zipPath} does not exist`);
            }
            
            // 解压缩到 testdata 目录
            await fs.createReadStream(zipPath)
                .pipe(unzipper.Extract({ path: testdataDir }))
                .promise();
                
        } else if (zipfile instanceof Buffer) {
            // 处理 Buffer - 先保存为临时文件再解压
            const tempZipPath = path.join(pdir, 'temp.zip');
            await fs.writeFile(tempZipPath, zipfile);
            
            // 解压缩到 testdata 目录
            await fs.createReadStream(tempZipPath)
                .pipe(unzipper.Extract({ path: testdataDir }))
                .promise();
            
            // 删除临时文件
            await fs.unlink(tempZipPath);
        }


        return { message: 'Problem setup completed successfully', pid };
    }

    // 添加新题目
    async addProblem(pid, config) {
        const pdir = path.join(this.problemsRoot, pid);
        // 检查是否已存在
        if (await dirExists(pdir)) {
            throw new Error(`Problem ${pid} already exists`);
        }
        await fs.mkdir(pdir, { recursive: true });

        // 写入 config.yaml
        const cfgPath = path.join(pdir, 'config.yaml');
        await fs.writeFile(cfgPath, YAML.dump(config), 'utf8');

        // 创建 testdata 目录
        const testdataDir = path.join(pdir, 'testdata');
        await fs.mkdir(testdataDir, { recursive: true });

        // 创建 checker 文件
        const checkerPath = path.join(pdir, 'chk.cc');
        if (config.checkerSource) {
            await fs.writeFile(checkerPath, config.checkerSource, 'utf8');
        } else {
            await fs.writeFile(checkerPath, '// Default checker code', 'utf8');
        }

        return { message: 'Problem added successfully', pid };
    }

    async deleteProblem(pid) {
        const pdir = path.join(this.problemsRoot, pid);
        if (!await dirExists(pdir)) {
            throw new Error(`Problem ${pid} does not exist`);
        }
        
        // 删除整个目录
        await fs.rm(pdir, { recursive: true, force: true });
        
        return { message: 'Problem deleted successfully', pid };
    }

    async getPackage(pid) {
        const pdir = path.join(this.problemsRoot, pid);
        if (!await dirExists(pdir)) {
            throw new Error(`Problem ${pid} does not exist`);
        }

        const packagePath = path.join(pdir, `${pid}.tar.gz`);
        
        // 使用 tar 打包
        await tar.create({
            gzip: true,
            file: packagePath,
            cwd: pdir,
            portable: true
        }, ['.']);

        return packagePath;
    }

}