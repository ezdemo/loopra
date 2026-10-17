package site.sorghum.loopra.web.model;

import java.util.List;

/**
 * Git 综合状态 —— 包含 Git 可用性、仓库初始化状态、当前分支及变更文件列表。
 *
 * @author Sorghum
 */
public record GitStatusDTO(
        boolean gitAvailable,
        boolean initialized,
        String branch,
        String workspacePath,
        List<GitFileChangeDTO> changed,
        List<GitFileChangeDTO> untracked,
        String model,
        String modelChannelId,
        int ahead,
        int behind,
        String upstream
) {
    /** 兼容只关心仓库状态的调用方（分支跟踪信息默认无）。 */
    public GitStatusDTO(boolean gitAvailable, boolean initialized, String branch, String workspacePath,
                        List<GitFileChangeDTO> changed, List<GitFileChangeDTO> untracked,
                        String model, String modelChannelId) {
        this(gitAvailable, initialized, branch, workspacePath, changed, untracked,
                model, modelChannelId, 0, 0, null);
    }
}
