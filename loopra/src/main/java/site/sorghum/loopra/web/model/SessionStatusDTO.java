package site.sorghum.loopra.web.model;

/**
 * 指定项目会话的后台 Agent 运行状态。
 */
public record SessionStatusDTO(
        boolean running,
        String requestId,
        String title
) {
    public SessionStatusDTO(boolean running, String requestId) {
        this(running, requestId, null);
    }
}
