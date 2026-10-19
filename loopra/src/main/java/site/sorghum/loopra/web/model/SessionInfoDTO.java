package site.sorghum.loopra.web.model;

/**
 * 会话信息。
 */
public record SessionInfoDTO(
        String name,
        String title,
        long messageCount,
        boolean current,
        long mtime,
        boolean worktreeMode,
        String agentId
) {
    public SessionInfoDTO(String name, String title, long count, boolean current, long mtime, boolean worktreeMode) {
        this(name, title, count, current, mtime, worktreeMode, "native");
    }
}
