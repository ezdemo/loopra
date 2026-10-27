package site.sorghum.loopra.bin.schedule;

import lombok.Data;

/** One completed execution of a scheduled task. */
@Data
public class ScheduleRun {
    private String id;
    private long startedAt;
    private long finishedAt;
    private String status;
    private String message;
    private String sessionName;
    private String result;
    private String error;
}
