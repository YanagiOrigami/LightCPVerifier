import express from 'express';
import tar from 'tar';
import { emptyDir } from 'utils.js';

export function createApiRoutes(judgeEngine, problemManager, submissionManager) {
    const router = express.Router();

    // 提交代码
    router.post('/submit', async (req, res) => {
        const { pid, lang, code } = req.body || {};
        if (!pid || !lang || !code) {
            return res.status(400).json({ error: 'pid/lang/code required' });
        }

        try {
            const sid = await judgeEngine.submit(pid, lang, code);
            res.json({ sid });
        } catch (error) {
            res.status(500).json({ error: 'Submit failed', message: error.message });
        }
    });

    // 获取结果
    router.get('/result/:sid', async (req, res) => {
        const sid = parseInt(req.params.sid, 10);
        if (Number.isNaN(sid)) {
            return res.status(400).json({ error: 'sid must be number' });
        }

        try {
            const result = await judgeEngine.getResult(sid);
            if (result) {
                res.json(result);
            } else {
                res.status(404).json({ error: 'not found' });
            }
        } catch (error) {
            res.status(500).json({ error: 'Failed to get result', message: error.message });
        }
    });

    // 获取题面
    router.get('/problem/:pid/statement', async (req, res) => {
        try {
            const statement = await problemManager.getStatement(req.params.pid);
            res.type('text/plain').send(statement);
        } catch {
            res.status(404).send('statement not found');
        }
    });

    // 获取所有题目列表
    router.get('/problems', async (req, res) => {
        try {
            const includeStatement = req.query.statement === 'true';
            const problems = await problemManager.listProblems(includeStatement);
            res.json({ problems });
        } catch (error) {
            res.status(500).json({ 
                error: 'Failed to list problems', 
                message: error.message 
            });
        }
    });

    // 导出 submissions
    router.get('/submissions/export', async (req, res) => {
        try {
            // 设置响应头
            res.setHeader('Content-Type', 'application/gzip');
            res.setHeader('Content-Disposition', `attachment; filename=submissions_${Date.now()}.tar.gz`);
            
            // 直接创建 tar 流并管道到响应
            tar.c(
                {
                    gzip: true,
                    cwd: submissionManager.submissionsRoot
                },
                ['.']
            ).pipe(res);
            
        } catch (error) {
            if (!res.headersSent) {
                res.status(500).json({ 
                    error: 'Failed to export submissions', 
                    message: error.message 
                });
            }
        }
    });

    // 重置 submissions
    router.post('/submissions/reset', async (req, res) => {
        try {
            // 清空 submissions 目录
            await emptyDir(submissionManager.submissionsRoot);
            
            // 重置 counter
            await submissionManager.resetCounter();
            
            // 清空内存中的结果缓存
            judgeEngine.clearResults();
            
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

    router.post('/problem/setup', async (req, res) => {
        const { pid, zipfile } = req.body || {};
        if (!pid) {
            return res.status(400).json({ error: 'pid is required' });
        }
        try {
            await problemManager.setupProblem(pid, zipfile);
            res.json({ message: 'Problem setup successfully', pid });
        } catch (error) {
            res.status(500).json({ error: 'Failed to setup problem', message: error.message });
        }
    });

    router.post('/problem/add-problem', async (req, res) => {
        const {pid} = req.body || {};
        if (!pid) {
            return res.status(400).json({ error: 'pid is required' });
        }
        try {
            const result = await problemManager.addProblem(pid, req.body);
            res.json(result);
        } catch (error) {
            res.status(500).json({ error: 'Failed to add problem', message: error.message });
        }

    });

    router.get('/package/:pid' , async (req, res) => {
        const pid = req.params.pid;
        if (!pid) {
            return res.status(400).json({ error: 'pid is required' });
        }

        try {
            const packagePath = await problemManager.getPackage(pid);
            if (packagePath) {
                res.download(packagePath, `${pid}.tar.gz`);
            } else {
                res.status(404).json({ error: 'Package not found' });
            }
        } catch (error) {
            res.status(500).json({ error: 'Failed to get package', message: error.message });
        }
    });

    // 健康检查
    router.get('/health', (_, res) => {
        res.json({ ok: true });
    });

    return router;
}