import fs from 'fs/promises';
import path from 'path';
import YAML from 'js-yaml';
import unzipper from 'unzipper';

import { dirExists, ensureDir, parseProblemConf, fileExists, findTestCases} from './utils.js';

export class ProblemConfig {
    constructor(pdir = null) {
        this.config = null;
        this.pdir = pdir;
        this.cases = [];
        this.checker = null;
        this.filename = null;
    }

    async loadConfig(configPath) {
        try{
            this.config = YAML.load(await fs.readFile(configPath, 'utf8'));
        } catch (error) {
            throw new Error(`Failed to load config: ${error.message}`);
        }
        
        // 验证配置类型
        const type = this.config.type || 'default';
        if (type !== 'default') {
            throw new Error('Only type=default supported');
        }
        
        // 验证 subtasks 存在
        if (!this.config.subtasks || !Array.isArray(this.config.subtasks)) {
            throw new Error('config.yaml must define subtasks');
        }
    }

    async loadSubtasks() {
        const cfg = this.config;
        const cases = [];
        
        // 获取全局默认值
        const globalTime = cfg.time_limit || cfg.time || '1s';
        const globalMemory = cfg.memory_limit || cfg.memory || '256m';
        const inputPrefix = cfg.input_prefix || '';
        const outputPrefix = cfg.output_prefix || '';
        const inputSuffix = cfg.input_suffix || '.in';
        const outputSuffix = cfg.output_suffix || '.ans';
        
        // 遍历每个 subtask
        let curCase = 1;
        for (let si = 0; si < cfg.subtasks.length; si++) {
            const st = cfg.subtasks[si];
            const subtaskTime = st.time_limit || st.time || globalTime;
            const subtaskMemory = st.memory_limit || st.memory || globalMemory;
            
            // 判断使用哪种方式加载测试用例
            if (st.n_cases !== undefined) {
                // 使用 n_cases 自动生成文件名
                for (let i = 0; i < st.n_cases; i++) {
                    cases.push({
                        subtask: si,
                        input: `${inputPrefix}${curCase + i}${inputSuffix}`,
                        output: `${outputPrefix}${curCase + i}${outputSuffix}`,
                        time: subtaskTime,
                        memory: subtaskMemory
                    });
                }
                curCase += st.n_cases;
            } else if (st.cases && Array.isArray(st.cases)) {
                // 使用显式指定的 cases
                st.cases.forEach(c => {
                    cases.push({
                        subtask: si,
                        input: c.input,
                        output: c.output,
                        time: c.time || subtaskTime,
                        memory: c.memory || subtaskMemory
                    });
                });
            } else {
                throw new Error(`Subtask ${si} must define either 'n_cases' or 'cases'`);
            }
        }
        
        this.cases = cases;
    }

    async loadClassic() {
        // 经典模式：加载 subtasks
        await this.loadSubtasks();
        
        // 设置 checker 和 filename
        this.checker = this.config.checker || 'chk.cc';
        this.filename = this.config.filename || null;
    }

    async loadLeetcode() {
        throw new Error('LeetCode problems are not supported for now.');
    }

    async loadInteractive() {
        throw new Error('Interactive problems are not supported for now.');
    }
    
    async loadProblem(pdir) {
        // 加载配置文件
        this.pdir = pdir;
        await this.loadConfig(path.join(this.pdir, 'config.yaml'));
        
        // 根据题目类型加载
        const type = this.config.type || 'default';
        
        switch (type) {
            case 'default':
                await this.loadClassic();
                break;
            case 'leetcode':
                await this.loadLeetcode();
                break;
            case 'interactive':
                await this.loadInteractive();
                break;
            default:
                throw new Error(`Unknown problem type: ${type}`);
        }
        
        // 返回与原代码兼容的格式
        return {
            pdir: this.pdir,
            cfg: this.config,
            cases: this.cases,
            checker: this.checker,
            filename: this.filename
        };
    }
}

export class ProblemSetter {
    constructor(dataDir, tarDir) {
        this.dataDir = dataDir;
        this.tarDir = tarDir;
    }

    // 复制文件
    async copyFile(src, dest) {
        await ensureDir(path.dirname(dest));
        await fs.copyFile(src, dest);
    }

    // 移动所有文件
    async moveAllFiles(srcDir, destDir) {
        await this.ensureDir(destDir);
        const files = await fs.readdir(srcDir);
        
        for (const file of files) {
            const srcPath = path.join(srcDir, file);
            const destPath = path.join(destDir, file);
            const stat = await fs.stat(srcPath);
            
            if (stat.isFile()) {
                await this.copyFile(srcPath, destPath);
            } else if (stat.isDirectory()) {
                await this.moveAllFiles(srcPath, destPath);
            }
        }
    }

    // Easy 模式：直接复制所有文件
    async setEasyMode() {
        // 使用 ProblemConfig 验证配置
        const loader = new ProblemConfig(this.dataDir);
        
        try {
            // 验证配置是否正确
            await loader.loadProblem();
            console.log(`Configuration validated`);
        } catch (err) {
            throw new Error(`Configuration validation failed: ${err.message}`);
        }
        
        // 验证通过，移动所有文件到目标目录
        await this.moveAllFiles(this.dataDir, this.tarDir);
        
        console.log(`Problem set successfully in EASY mode`);
        return { mode: 'easy', targetDir: this.tarDir };
    }

    // Hard 模式：生成配置并整理文件
    async setHardMode() {
        console.log(`Setting problem in HARD mode`);
        
        // 默认配置
        let timeLimit = '2s';
        let memoryLimit = '512m';
        
        // 尝试读取 problem.conf
        const confPath = path.join(this.dataDir, 'problem.conf');
        if (await fileExists(confPath)) {
            console.log('Found problem.conf, parsing...');
            const conf = await parseProblemConf(confPath);

            if (conf.time_limit || conf.timelimit) {
                const timeSec = conf.time_limit || conf.timelimit;
                timeLimit = `${timeSec}s`;
            }
            
            if (conf.memory_limit || conf.memorylimit || conf.memory) {
                const memMB = conf.memory_limit || conf.memorylimit || conf.memory;
                memoryLimit = `${memMB}m`;
            }
        }
        
        // 查找测试用例对
        const testCases = await findTestCases(this.dataDir);
        if (testCases.length === 0) {
            throw new Error('No matching test case pairs found');
        }
        
        console.log(`Found ${testCases.length} test case pairs`);
        
        const testdataDir = path.join(this.tarDir, 'testdata');
        await this.ensureDir(testdataDir);
        
        // 复制并重命名测试用例
        const cases = [];
        for (let i = 0; i < testCases.length; i++) {
            const testCase = testCases[i];
            const newIndex = i + 1;
            
            // 复制输入文件
            await this.copyFile(
                path.join(problemDir, testCase.input),
                path.join(testdataDir, `${newIndex}.in`)
            );
            
            // 复制输出文件
            await this.copyFile(
                path.join(problemDir, testCase.output),
                path.join(testdataDir, `${newIndex}.ans`)
            );
            
            cases.push({
                input: `${newIndex}.in`,
                output: `${newIndex}.ans`
            });
        }
        
        // 生成 config.yaml
        const config = {
            type: 'default',
            time_limit: timeLimit,
            memory_limit: memoryLimit,
            checker: 'checker.cpp',
            input_prefix: '',
            output_prefix: '',
            input_suffix: '.in',
            output_suffix: '.ans',
            subtasks: [
                {
                    score: 100,
                    n_cases: testCases.length
                }
            ]
        };
        
        // 写入配置文件
        const configPath = path.join(targetDir, 'config.yaml');
        await fs.writeFile(configPath, YAML.stringify(config), 'utf8');

        // 复制其他必要文件（如 checker.cpp, statement.txt 等）
        const otherFiles = ['checker.cpp', 'statement.txt', 'chk.cc', 'chk.cpp'];
        for (const file of otherFiles) {
            const srcPath = path.join(this.dataDir, file);
            if (await fileExists(srcPath)) {
                await this.copyFile(srcPath, path.join(this.tarDir, file));
            }
        }

        console.log(`Problem set successfully in HARD mode`);
        console.log(`Generated config with ${testCases.length} test cases`);
        
        return {
            mode: 'hard',
            pid,
            targetDir: this.tarDir,
            testCases: testCases.length,
            timeLimit,
            memoryLimit
        };
    }

    // 主入口
    async setProblem() {
        // 检查题目目录是否存在
        if (!(await fileExists(problemDir))) {
            throw new Error(`Problem directory not found: ${problemDir}`);
        }
        
        // 检查是否有 config.yaml（Easy 模式）
        const configPath = path.join(problemDir, 'config.yaml');
        if (await fileExists(configPath)) {
            return await this.setEasyMode(pid, problemDir);
        } else {
            // Hard 模式
            return await this.setHardMode(pid, problemDir);
        }
    }
}

export class ProblemManager {
    constructor(problemsRoot) {
        this.problemsRoot = problemsRoot;
    }

    // 加载单个题目
    async loadProblem(pid) {
        const pdir = path.join(this.problemsRoot, pid);
        return ProblemConfig().loadProblem(pdir);
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

    // 读取交互器源码
    async readInteractorSource(pid, interactorFile = 'interactor.cc') {
        const filePath = path.join(this.problemsRoot, pid, interactorFile);
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

        if (zipfile instanceof Buffer) {
            const tempZipPath = path.join(pdir, 'temp.zip');
            await fs.writeFile(tempZipPath, zipfile);
            zipfile = String(tempZipPath);
        }

        if (typeof zipfile === 'string') {
            // 处理字符串路径
            const zipPath = path.resolve(zipfile);
            if (!await dirExists(zipPath)) {
                throw new Error(`Zip file ${zipPath} does not exist`);
            }
            const tmpDir = path.join(pdir, "tmp_" + pid);
            // 解压缩到 tmpDir 目录
            await fs.createReadStream(zipPath)
                .pipe(unzipper.Extract({ path: tmpDir }))
                .promise();

            await fs.unlink(zipPath);
            
            let Setter = new ProblemSetter(tmpDir, pdir);
            try{
                await Setter.setProblem();
            } catch (error) {
                await fs.rm(tmpDir, { recursive: true, force: true });
                throw new Error(`Failed to set problem: ${error.message}`);
            }
        }

        return { message: 'Problem setup completed successfully', pid };
    }

    // 添加新题目
    async addProblem(pid, zipfile) {
        const pdir = path.join(this.problemsRoot, pid);
        // 检查是否已存在
        if (await dirExists(pdir)) {
            throw new Error(`Problem ${pid} already exists`);
        }
        await fs.mkdir(pdir, { recursive: true });

        if (zipfile) {
            await this.setupProblem(pid, zipfile);
            return { message: 'Problem added and setup successfully', pid };
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
        try{
            await fs.access(packagePath);
        } catch {
            throw new Error(`Package ${packagePath} does not exist`);
        }
        return packagePath;
    }

}