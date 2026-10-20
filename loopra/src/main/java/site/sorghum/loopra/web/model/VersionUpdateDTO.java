package site.sorghum.loopra.web.model;

/**
 * 后台核心服务更新任务状态。
 *
 * @param running 是否仍在执行
 * @param state 任务状态：idle、starting、running、success、failed、stopped
 * @param platform 当前平台
 * @param target 更新目标
 * @param logFile 更新日志路径
 * @param log 最近的更新日志内容
 * @param message 给用户的提示
 */
public record VersionUpdateDTO(
        boolean running,
        String state,
        String platform,
        String target,
        String logFile,
        String log,
        String message
) {
}
