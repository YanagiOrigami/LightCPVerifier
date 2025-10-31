import fs from 'fs/promises';
import path from 'path';
import YAML from 'js-yaml';
import unzipper from 'unzipper';
import tar from 'tar';
import { GoJudgeClient } from './gojudge.js';

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
        
        // 验证 subtasks 存在
        if (!this.config.subtasks || !Array.isArray(this.config.subtasks)) {
            throw new Error('config.yaml must define subtasks');
        }
        return this.config;
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
        //throw new Error('Interactive problems are not supported for now.');
        
         // 交互模式：加载 subtasks
        await this.loadSubtasks();
        this.checker = this.config.checker || 'chk.cc';
        this.interactor = this.config.interactor || 'interactor.cc';
        //console.log('Loading interactive problem, the interactor is:', this.config.interactor);
        this.filename = this.config.filename || null;
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
            interactor: this.interactor,
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
        await ensureDir(destDir);
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
            await loader.loadProblem(this.dataDir);
            console.log(`Configuration validated`);
        } catch (err) {
            throw new Error(`Configuration validation failed: ${err.message}`);
        }
        
        // 验证通过，移动所有文件到目标目录
        await this.moveAllFiles(this.dataDir, this.tarDir);
        
        console.log(`Problem set successfully in EASY mode`);
        return { mode: 'easy', targetDir: this.tarDir };
    }

    // Free 模式：生成配置并整理文件
    async setFreeMode() {
        console.log(`Setting problem in FREE mode`);

        // 默认配置
        let timeLimit = '2s';
        let memoryLimit = '512m';
        let mode = 'default';

        // 尝试读取 problem.conf
        const confPath = path.join(this.dataDir, 'problem.conf');
        if (await fileExists(confPath)) {
            console.log('Found problem.conf, parsing...');
            const conf = await parseProblemConf(confPath);
            if (conf.interaction_mode === 'on') {
                mode = 'interactive';
            }

            if (conf.time_limit || conf.timelimit) {
                const timeSec = conf.time_limit || conf.timelimit;
                timeLimit = `${timeSec}s`;
            }
            
            if (conf.memory_limit || conf.memorylimit || conf.memory) {
                const memMB = conf.memory_limit || conf.memorylimit || conf.memory;
                memoryLimit = `${memMB}m`;
            }

        }

        let checker_name;
        const candidates = ['checker.cpp', 'checker.cc', 'chk.cpp', 'chk.cc'];

        for (const fname of candidates) {
            const fpath = path.join(this.dataDir, fname);
            if (await fileExists(fpath)) {
                checker_name = fname;
                break; 
            }
        }
        if (!checker_name && mode === 'default') {
            throw new Error('No checker source file found (expected one of: ' + candidates.join(', ') + ')');
        }

        let interactor_name;
        const interactorCandidates = ['interactor.cpp', 'interactor.cc'];

        for (const fname of interactorCandidates) {
            const fpath = path.join(this.dataDir, fname);
            if (await fileExists(fpath)) {
                interactor_name = fname;
                break;
            }
        }
        if (mode === 'interactive' && !interactor_name) {
            throw new Error('Interactive mode requires an interactor source file (expected one of: ' + interactorCandidates.join(', ') + ')');
        }

        // 查找测试用例对
        const testCases = await findTestCases(this.dataDir);
        if (testCases.length === 0) {
            throw new Error('No matching test case pairs found');
        }
        
        console.log(`Found ${testCases.length} test case pairs`);
        
        const testdataDir = path.join(this.tarDir, 'testdata');
        await ensureDir(testdataDir);
        
        // 复制并重命名测试用例
        const cases = [];
        for (let i = 0; i < testCases.length; i++) {
            const testCase = testCases[i];
            const newIndex = i + 1;
            
            // 复制输入文件
            await this.copyFile(
                path.join(this.dataDir, testCase.input),
                path.join(testdataDir, `${newIndex}.in`)
            );
            
            // 复制输出文件
            await this.copyFile(
                path.join(this.dataDir, testCase.output),
                path.join(testdataDir, `${newIndex}.ans`)
            );
            
            cases.push({
                input: `${newIndex}.in`,
                output: `${newIndex}.ans`
            });
        }
        
        // 生成 config.yaml
        const config = {
            type: mode,
            time_limit: timeLimit,
            memory_limit: memoryLimit,
            checker: checker_name,
            interactor: interactor_name,
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
        const configPath = path.join(this.tarDir, 'config.yaml');
        await fs.writeFile(configPath, YAML.dump(config), 'utf8');

        // 复制其他必要文件（如 checker.cpp, statement.txt 等）
        const otherFiles = ['checker.cpp', 'statement.txt', config.checker, config.interactor].filter(f => f);
        for (const file of otherFiles) {
            const srcPath = path.join(this.dataDir, file);
            if (await fileExists(srcPath)) {
                await this.copyFile(srcPath, path.join(this.tarDir, file));
            }
        }

        console.log(`Problem set successfully in FREE mode`);
        console.log(`Generated config with ${testCases.length} test cases`);
        
        return {
            mode: 'free',
            targetDir: this.tarDir,
            testCases: testCases.length,
            timeLimit,
            memoryLimit
        };
    }

    // 主入口
    async setProblem() {
        // 检查题目目录是否存在
        if (!(await fileExists(this.dataDir))) {
            throw new Error(`Problem directory not found: ${this.dataDir}`);
        }
        
        // 检查是否有 config.yaml（Easy 模式）
        const configPath = path.join(this.dataDir, 'config.yaml');
        if (await fileExists(configPath)) {
            return await this.setEasyMode();
        } else {
            // Free 模式
            return await this.setFreeMode();
        }
    }
}

export class ProblemManager {
    constructor(config) {
        this.problemsRoot = config.problemsRoot;
        this.gjAddr = config.gjAddr || 'http://localhost:8080';
        this.testlibPath = config.testlibPath || '/lib/testlib';

        this.goJudge = new GoJudgeClient(config.gjAddr);
    }

    // 加载单个题目
    async loadProblem(pid) {
        const pdir = path.join(this.problemsRoot, pid);
        return new ProblemConfig().loadProblem(pdir);
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
    async readInteractorSource(pid, interactorFile = 'interactor.cpp') {
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

        if (typeof zipfile === 'string') {
            // 处理字符串路径
            const zipPath = path.resolve(zipfile);
            if (!await dirExists(zipPath)) {
                throw new Error(`Zip file ${zipPath} does not exist`);
            }
            const tmpDir = path.join(pdir, "tmp_" + pid);
            try {
                const directory = await unzipper.Open.file(zipPath);
                await directory.extract({ path: tmpDir })   ;
                const files = await fs.readdir(tmpDir, { recursive: true });
            } catch (error) {
                throw new Error(`Failed to unzip file: ${error.message}`);
            }
            await fs.unlink(zipPath);
            let Setter = new ProblemSetter(tmpDir, pdir);
            try {
                await Setter.setProblem();
            } catch (error) {
                await fs.rm(tmpDir, { recursive: true, force: true });
                throw new Error(`Failed to set problem: ${error.message}`);
            }
            await fs.rm(tmpDir, { recursive: true, force: true });
        }

        let config;
        try {
            config = await new ProblemConfig(pdir).loadConfig(path.join(pdir, 'config.yaml'));
        } catch (error) {
            throw new Error(`Failed to load problem config: ${error.message}`);
        }
        const checker_name = config.checker || undefined;
        if (checker_name) {
            const checker_source = await this.readCheckerSource(pid, checker_name);
            try {
                const checkerBin = await this.goJudge.getCheckerBin(checker_source, config.testlibPath);
                const checkerBinPath = path.join(pdir, `${checker_name}.bin`);
                await fs.writeFile(checkerBinPath, checkerBin);
            } catch (error) {
                throw new Error(`Failed to get checker binary: ${error.message}`);
            }
        }
        const interactor_name = config.interactor || undefined;
        if (interactor_name) {
            const interactor_source = await this.readInteractorSource(pid, interactor_name);
            try {
                const interactorBin = await this.goJudge.getCheckerBin(interactor_source, config.testlibPath);
                const interactorBinPath = path.join(pdir, `${interactor_name}.bin`);
                await fs.writeFile(interactorBinPath, interactorBin);
            } catch (error) {
                throw new Error(`Failed to get interactor binary: ${error.message}`);
            }
        }

        // 打包成 tar.gz
        await tar.c({
            gzip: true,
            cwd: pdir,  // 👈 改变工作目录
            file: path.join(pdir, `${pid}.tar.gz`)
        }, ['.']);
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
            try{
                await this.setupProblem(pid, zipfile);
            } catch (error) {
                throw new Error(`Failed to setup problem: ${error.message}`);
            }
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