package site.sorghum.loopra.bin.schedule;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.io.Serializable;
import java.util.List;

/**
 * 定时任务数据模型。
 * <p>
 * 每个定时任务绑定到一个项目下的某个会话，
 * 在指定时间向该会话的 Agent 发送消息并获取回复。
 * </p>
 *
 * @author Sorghum
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ScheduledTask implements Serializable {

    /** 唯一标识 */
    private volatile String id;

    /** 任务名称 */
    private volatile String name;

    /** 目标会话名称 */
    private volatile String sessionName;

    /** "independent" creates a new session per run; missing means legacy existing-session mode. */
    private volatile String sessionMode;

    /**
     * Cron 表达式（如 "0 0 9 * * ?" 表示每天 9:00）。
     * 优先级高于 intervalSec，非空时使用 cron 调度。
     */
    private volatile String cronExpr;

    /**
     * 固定间隔（秒），与 cronExpr 二选一。
     * cronExpr 为空时生效。
     */
    private volatile Long intervalSec;

    /** 要发送的消息内容 */
    private volatile String message;

    /** 是否启用 */
    private volatile boolean enabled;

    /** 上次执行时间戳（ms） */
    private volatile long lastRunAt;

    /** 下次执行时间戳（ms） */
    private volatile long nextRunAt;

    /** 执行次数累计 */
    private volatile int runCount;

    /** 上次执行结果摘要 */
    private volatile String lastResult;

    /** 上次错误信息 */
    private volatile String lastError;

    /** Completed executions; older tasks may not have history. */
    private volatile List<ScheduleRun> runs;

    /** 创建时间 */
    private volatile long createdAt;

    /** 更新时间 */
    private volatile long updatedAt;

    /**
     * 计算下次执行时间（基于 cronExpr 或 intervalSec）。
     *
     * @return 下次执行时间戳（ms），-1 表示无法计算
     */
    public long computeNextRunAt() {
        long now = System.currentTimeMillis();
        long base = lastRunAt > 0 ? lastRunAt : now;
        return computeNextRunAt(base);
    }

    public long computeNextRunAt(long base) {
        if (cronExpr != null && !cronExpr.isBlank()) {
            // 使用简化的 cron 解析
            return CronParser.nextTime(cronExpr, base);
        }

        if (intervalSec != null && intervalSec > 0) {
            return base + intervalSec * 1000L;
        }

        return -1;
    }
}
