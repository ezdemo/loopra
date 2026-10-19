package site.sorghum.loopra.web.model;

/**
 * 会话环境的 Git 状态。
 *
 * <p>路径全部由后端根据 workspaceHash + sessionName 解析，客户端不能传入任意目录。</p>
 */
public record EnvironmentGitStatusDTO(
        String workspaceHash,
        String sessionName,
        String mode,
        String mainPath,
        String mainBranch,
        String currentPath,
        String currentBranch,
        GitStatusDTO main,
        GitStatusDTO current
) {
}
