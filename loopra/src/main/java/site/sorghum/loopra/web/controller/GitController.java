package site.sorghum.loopra.web.controller;

import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import io.swagger.annotations.ApiParam;
import org.noear.solon.annotation.Body;
import org.noear.solon.annotation.Controller;
import org.noear.solon.annotation.Get;
import org.noear.solon.annotation.Inject;
import org.noear.solon.annotation.Mapping;
import org.noear.solon.annotation.Param;
import org.noear.solon.annotation.Post;
import site.sorghum.loopra.web.model.ApiResponse;
import site.sorghum.loopra.web.model.EnvironmentGitStatusDTO;
import site.sorghum.loopra.web.model.EnvironmentStatusDTO;
import site.sorghum.loopra.web.model.GitBranchDTO;
import site.sorghum.loopra.web.model.GitCommitDTO;
import site.sorghum.loopra.web.model.GitCommitResultDTO;
import site.sorghum.loopra.web.model.GitDiffContentDTO;
import site.sorghum.loopra.web.model.GitDiffDTO;
import site.sorghum.loopra.web.model.GitFileContentDTO;
import site.sorghum.loopra.web.model.GitGenerateMessageDTO;
import site.sorghum.loopra.web.model.GitStatusDTO;
import site.sorghum.loopra.web.model.WorkingFileContentDTO;
import site.sorghum.loopra.web.model.WorktreeRequest;
import site.sorghum.loopra.web.model.WorktreeStatusDTO;
import site.sorghum.loopra.web.service.GitService;
import site.sorghum.loopra.web.service.WorktreeService;

import java.util.Map;

/**
 * Git 管理 API —— 提供 Git 状态查看、仓库初始化、暂存/取消暂存、提交、
 * Diff 内容查看及历史版本文件内容获取等完整的 Git 管理能力。
 * <p>
 * 业务逻辑已委托给 {@link GitService}，本控制器仅负责请求映射和参数绑定。
 * 异常由 {@link site.sorghum.loopra.web.common.GlobalExceptionFilter} 统一处理。
 * </p>
 *
 * @author Sorghum
 */
@Api(tags = "Git")
@Controller
@Mapping("/api/git")
public class GitController {

    @Inject
    private GitService gitService;

    @Inject
    private WorktreeService worktreeService;

    // ==================== 查询端点 ====================

    @ApiOperation(value = "获取当前 Git 分支", notes = "返回项目所在 Git 仓库的当前分支名称")
    @Get
    @Mapping("/branch")
    public ApiResponse<GitBranchDTO> branch(
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash", required = false) String workspaceHash) {
        String branch = gitService.getBranch(workspaceHash);
        return ApiResponse.ok(new GitBranchDTO(branch));
    }

    @ApiOperation(value = "获取 Git 变更文件列表", notes = "返回暂存、未暂存和未跟踪的文件变更列表")
    @Get
    @Mapping("/diff")
    public ApiResponse<GitDiffDTO> diff(
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash", required = false) String workspaceHash) {
        return ApiResponse.ok(gitService.getDiff(workspaceHash));
    }

    @ApiOperation(value = "Git 综合状态检测",
            notes = "依次检测 Git 是否安装、项目是否初始化为 Git 仓库、获取当前分支名及变更文件列表")
    @Get
    @Mapping("/status")
    public ApiResponse<GitStatusDTO> status(
            @ApiParam(value = "项目 hash")
            @Param(value = "workspaceHash", required = false) String workspaceHash) throws Exception {
        return ApiResponse.ok(gitService.getStatus(workspaceHash));
    }

    @ApiOperation(value = "获取 Git Diff 内容",
            notes = "返回完整的 unified diff 文本和 stat 变更统计摘要。单文件 diff 超过 2000 行时自动截断")
    @Get
    @Mapping("/diff-content")
    public ApiResponse<GitDiffContentDTO> diffContent(
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash", required = false) String workspaceHash,
            @ApiParam(value = "可选的文件路径，用于查看指定文件的 diff")
            @Param(value = "path", required = false) String path) throws Exception {
        return ApiResponse.ok(gitService.getDiffContent(workspaceHash, path));
    }

    @ApiOperation(value = "获取 Git 仓库中指定版本的文件内容",
            notes = "通过 git show ref:path 获取文件内容，默认 ref 为 HEAD")
    @Get
    @Mapping("/file-content")
    public ApiResponse<GitFileContentDTO> fileContent(
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash", required = false) String workspaceHash,
            @ApiParam(value = "文件路径（相对于仓库根目录）") @Param("path") String path,
            @ApiParam(value = "Git 引用（分支名、标签、提交哈希等），默认为 HEAD")
            @Param(value = "ref", required = false) String ref) throws Exception {
        return ApiResponse.ok(gitService.getFileContent(workspaceHash, path, ref));
    }

    @ApiOperation(value = "获取项目当前文件内容", notes = "用于前端代码预览，读取当前项目文件而非 Git 提交版本")
    @Get
    @Mapping("/working-file-content")
    public ApiResponse<WorkingFileContentDTO> workingFileContent(
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash", required = false) String workspaceHash,
            @ApiParam(value = "文件路径（项目相对路径或项目内绝对路径）") @Param("path") String path) throws Exception {
        return ApiResponse.ok(gitService.getWorkingFileContent(workspaceHash, path));
    }

    @ApiOperation(value = "获取 Git 提交历史记录",
            notes = "返回 Git 仓库最近 N 条提交记录，默认 50 条")
    @Get
    @Mapping("/log")
    public ApiResponse<GitCommitDTO.ListWrapper> log(
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash", required = false) String workspaceHash,
            @ApiParam(value = "返回条数，默认 50") @Param(value = "limit", required = false) Integer limit) {
        return ApiResponse.ok(gitService.getCommitHistory(workspaceHash, limit));
    }

    // ==================== 操作端点 ====================

    @ApiOperation(value = "初始化 Git 仓库",
            notes = "在项目执行 git init，自动生成 .gitignore 文件（仅当文件不存在时），可选执行初始提交")
    @Post
    @Mapping("/init")
    public ApiResponse<Map<String, Object>> init(
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash", required = false) String workspaceHash,
            @ApiParam(value = "是否执行初始提交，默认为 false")
            @Param(value = "initialCommit", required = false) Boolean initialCommit) throws Exception {
        return ApiResponse.ok(gitService.initRepo(workspaceHash, initialCommit));
    }

    @ApiOperation(value = "Git 提交",
            notes = "支持精确文件列表或全量 add -A。请求体为 JSON：{ \"message\": \"...\", \"files\": [\"a.java\", \"b.css\"] }")
    @Post
    @Mapping("/commit")
    public ApiResponse<GitCommitResultDTO> commit(
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash", required = false) String workspaceHash,
            @Body String body) throws Exception {
        return ApiResponse.ok(gitService.commit(workspaceHash, body));
    }

    @ApiOperation(value = "暂存或取消暂存文件及目录", notes = "path 为项目内相对路径；staged=true 暂存全部改动，false 取消暂存。省略 staged 时兼容旧版切换操作")
    @Post
    @Mapping("/toggle")
    public ApiResponse<Map<String, Object>> toggle(
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash", required = false) String workspaceHash,
            @Body String body) throws Exception {
        return ApiResponse.ok(gitService.toggleFile(workspaceHash, body));
    }

    @ApiOperation(value = "获取提交作者配置",
            notes = "返回已保存配置 > git config > Loopra 默认 三级的合并结果")
    @Get
    @Mapping("/config")
    public ApiResponse<Map<String, String>> config(
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash", required = false) String workspaceHash) {
        return ApiResponse.ok(gitService.getGitConfig(workspaceHash));
    }

    @ApiOperation(value = "保存提交作者配置",
            notes = "将 authorName/authorEmail 保存到项目 .loopra/git-author.json")
    @Post
    @Mapping("/config")
    public ApiResponse<Map<String, String>> saveConfig(
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash", required = false) String workspaceHash,
            @Body String body) throws Exception {
        return ApiResponse.ok(gitService.saveGitConfig(workspaceHash, body));
    }

    // ==================== AI 辅助 ====================

    @ApiOperation(value = "AI 自动生成 Git 提交消息",
            notes = "根据全部变更文件名、最多 3 个文件的 git diff 和近 3 条提交日志，调用 AI 生成符合风格的提交消息。支持传入 files 数组仅针对选中文件生成")
    @Post
    @Mapping("/generate-commit-message")
    public ApiResponse<GitGenerateMessageDTO> generateCommitMessage(
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash", required = false) String workspaceHash,
            @Body String body) throws Exception {
        return ApiResponse.ok(gitService.generateCommitMessage(workspaceHash, body));
    }

    @ApiOperation(value = "AI 生成当前会话环境的提交消息",
            notes = "根据会话当前实际使用的目录（隔离分支优先，否则主项目）的变更文件名、最多 3 个文件 diff 和近 3 条提交日志生成提交消息；Git 操作由 Desktop 端执行")
    @Post
    @Mapping("/generate-environment-commit-message")
    public ApiResponse<GitGenerateMessageDTO> generateEnvironmentCommitMessage(
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "会话名称", required = true) @Param(value = "sessionName", required = true) String sessionName,
            @Body String body) throws Exception {
        EnvironmentStatusDTO environment = worktreeService.environment(workspaceHash, sessionName);
        String targetPath = environment.currentPath();
        if (targetPath == null || targetPath.isBlank()) {
            throw new site.sorghum.loopra.web.common.ServiceException(
                    "当前环境不可用：" + (environment.message() == null ? "隔离分支尚未创建" : environment.message()));
        }
        return ApiResponse.ok(gitService.generateCommitMessageAtPath(targetPath, environment.workspaceHash(), body));
    }

    @ApiOperation(value = "获取当前会话环境", notes = "返回 Agent 当前使用的本地项目或隔离分支")
    @Get
    @Mapping("/environment")
    public ApiResponse<EnvironmentStatusDTO> environment(
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "会话名称", required = true) @Param(value = "sessionName", required = true) String sessionName) {
        return ApiResponse.ok(worktreeService.environment(workspaceHash, sessionName));
    }

    @ApiOperation(value = "获取会话环境的 Git 状态", notes = "由后端解析主项目与会话隔离分支目录，返回两边完整的状态与分支跟踪信息")
    @Get
    @Mapping("/environment/status")
    public ApiResponse<EnvironmentGitStatusDTO> environmentStatus(
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "会话名称", required = true) @Param(value = "sessionName", required = true) String sessionName) throws Exception {
        EnvironmentStatusDTO environment = worktreeService.environment(workspaceHash, sessionName);
        GitStatusDTO main = environment.mainPath() == null ? null : gitService.getStatusAt(environment.mainPath());
        GitStatusDTO current = environment.currentPath() == null ? null
                : environment.currentPath().equals(environment.mainPath()) ? main
                : gitService.getStatusAt(environment.currentPath());
        return ApiResponse.ok(new EnvironmentGitStatusDTO(
                environment.workspaceHash(), environment.sessionName(), environment.mode(),
                environment.mainPath(), environment.mainBranch(),
                environment.currentPath(), environment.currentBranch(), main, current));
    }

    @ApiOperation(value = "获取会话环境的提交历史", notes = "scope=main 读取主项目，scope=current 读取隔离分支；路径由后端解析")
    @Get
    @Mapping("/environment/log")
    public ApiResponse<GitCommitDTO.ListWrapper> environmentLog(
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "会话名称", required = true) @Param(value = "sessionName", required = true) String sessionName,
            @ApiParam(value = "main 或 current", required = false) @Param(value = "scope", required = false) String scope,
            @ApiParam(value = "返回条数，默认 30") @Param(value = "limit", required = false) Integer limit) {
        EnvironmentStatusDTO environment = worktreeService.environment(workspaceHash, sessionName);
        boolean main = "main".equalsIgnoreCase(scope);
        if (scope != null && !scope.isBlank() && !main && !"current".equalsIgnoreCase(scope)) {
            throw new site.sorghum.loopra.web.common.ServiceException("scope 只能是 main 或 current");
        }
        String path = main ? environment.mainPath() : environment.currentPath();
        if (path == null) throw new site.sorghum.loopra.web.common.ServiceException("隔离分支尚未创建");
        return ApiResponse.ok(gitService.getCommitHistoryAt(path, limit));
    }

    @ApiOperation(value = "提交会话环境改动", notes = "在 Agent 当前使用的目录执行 add -A 与 commit，隔离分支与本地项目共用")
    @Post
    @Mapping("/environment/commit")
    public ApiResponse<GitCommitResultDTO> environmentCommit(
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "会话名称", required = true) @Param(value = "sessionName", required = true) String sessionName,
            @ApiParam(value = "请求体：{message}") @Body String body) throws Exception {
        EnvironmentStatusDTO environment = worktreeService.environment(workspaceHash, sessionName);
        if (environment.currentPath() == null) {
            throw new site.sorghum.loopra.web.common.ServiceException("当前环境不可用：" + environment.message());
        }
        return ApiResponse.ok(gitService.commitEnvironment(environment.currentPath(), body));
    }

    @ApiOperation(value = "推送主项目", notes = "隔离分支需先合并到主项目；推送沿用仓库已配置的 upstream")
    @Post
    @Mapping("/environment/push")
    public ApiResponse<Map<String, Object>> environmentPush(
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "会话名称", required = true) @Param(value = "sessionName", required = true) String sessionName) throws Exception {
        EnvironmentStatusDTO environment = worktreeService.environment(workspaceHash, sessionName);
        if (environment.mainPath() == null) {
            throw new site.sorghum.loopra.web.common.ServiceException("当前环境不可用：" + environment.message());
        }
        return ApiResponse.ok(Map.of("message", gitService.pushAtPath(environment.mainPath())));
    }

    @ApiOperation(value = "暂存或取消暂存会话环境文件", notes = "在 Agent 当前使用的目录执行 git add/reset，隔离分支与本地项目共用")
    @Post
    @Mapping("/environment/toggle")
    public ApiResponse<Map<String, Object>> environmentToggle(
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "会话名称", required = true) @Param(value = "sessionName", required = true) String sessionName,
            @ApiParam(value = "请求体：{path, staged}") @Body String body) throws Exception {
        EnvironmentStatusDTO environment = worktreeService.environment(workspaceHash, sessionName);
        if (environment.currentPath() == null) {
            throw new site.sorghum.loopra.web.common.ServiceException("当前环境不可用：" + environment.message());
        }
        return ApiResponse.ok(gitService.toggleFileAt(environment.currentPath(), body));
    }

    @ApiOperation(value = "获取会话环境文件的 Diff", notes = "读取隔离分支或本地项目内文件相对 HEAD 的 diff")
    @Get
    @Mapping("/environment/diff-content")
    public ApiResponse<GitDiffContentDTO> environmentDiffContent(
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "会话名称", required = true) @Param(value = "sessionName", required = true) String sessionName,
            @ApiParam(value = "文件路径") @Param(value = "path", required = false) String path) throws Exception {
        EnvironmentStatusDTO environment = worktreeService.environment(workspaceHash, sessionName);
        if (environment.currentPath() == null) {
            throw new site.sorghum.loopra.web.common.ServiceException("当前环境不可用：" + environment.message());
        }
        return ApiResponse.ok(gitService.getDiffContentAt(environment.currentPath(), path));
    }

    @ApiOperation(value = "读取会话环境当前文件内容", notes = "读取隔离分支或本地项目内的文件内容")
    @Get
    @Mapping("/environment/working-file-content")
    public ApiResponse<WorkingFileContentDTO> environmentWorkingFileContent(
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "会话名称", required = true) @Param(value = "sessionName", required = true) String sessionName,
            @ApiParam(value = "文件路径") @Param(value = "path") String path) throws Exception {
        EnvironmentStatusDTO environment = worktreeService.environment(workspaceHash, sessionName);
        if (environment.currentPath() == null) {
            throw new site.sorghum.loopra.web.common.ServiceException("当前环境不可用：" + environment.message());
        }
        return ApiResponse.ok(gitService.getWorkingFileContentAt(environment.currentPath(), path));
    }

    // ==================== 会话隔离分支 ====================

    @ApiOperation(value = "创建会话隔离分支", notes = "在 ~/.loopra/worktree/ 下基于主项目 HEAD 创建独立分支隔离分支（幂等）")
    @Post
    @Mapping("/worktree/create")
    public ApiResponse<WorktreeStatusDTO> worktreeCreate(@Body WorktreeRequest request) {
        if (request == null || request.getWorkspaceHash() == null || request.getSessionName() == null) {
            throw new site.sorghum.loopra.web.common.ServiceException("workspaceHash 与 sessionName 必填");
        }
        return ApiResponse.ok(worktreeService.create(request.getWorkspaceHash(), request.getSessionName()));
    }

}
