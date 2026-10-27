package site.sorghum.loopra.bin.schedule;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
  * 6 字段格式的简化 Cron 表达式解析器。
 */
public class CronParser {

    private static final Pattern STEP_PATTERN = Pattern.compile("(\\*|\\d+)/(\\d+)");
    private static final Pattern RANGE_PATTERN = Pattern.compile("(\\d+)-(\\d+)");
    private static final int MIN_CRON_FIELDS = 6;

    public static long nextTime(String cronExpr, long baseTime) {
        try {
            String[] fields = cronExpr.trim().split("\\s+");
            if (fields.length < MIN_CRON_FIELDS) {
                return -1;
            }

            Set<Integer> seconds = parseField(fields[0], 0, 59);
            Set<Integer> minutes = parseField(fields[1], 0, 59);
            Set<Integer> hours = parseField(fields[2], 0, 23);
            Set<Integer> daysOfMonth = parseField(fields[3], 1, 31);
            Set<Integer> months = parseField(fields[4], 1, 12);
            Set<Integer> daysOfWeek = parseDayOfWeekField(fields[5]);

            LocalDateTime base = LocalDateTime.ofInstant(
                    java.time.Instant.ofEpochMilli(baseTime),
                    ZoneId.systemDefault());

            LocalDateTime deadline = base.plusYears(4);
            // 从 base 时间的下一秒开始搜索
            LocalDateTime candidate = base.plusSeconds(1).withNano(0);

            // 预计算通配标记
            boolean domWild = daysOfMonth.size() >= 31;
            boolean dowWild = daysOfWeek.size() >= 7;

            while (candidate.isBefore(deadline)) {
                if (matches(candidate, seconds, minutes, hours, daysOfMonth, months, daysOfWeek)) {
                    return candidate.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli();
                }
                // 优化跳步：根据不匹配的最小粒度跳跃
                if (!months.contains(candidate.getMonthValue())) {
                    candidate = candidate.plusMonths(1).withDayOfMonth(1).withHour(0).withMinute(0).withSecond(0).withNano(0);
                } else {
                    // 日期匹配逻辑（与 matches 方法一致）
                    boolean dateMatch;
                    if (!domWild && !dowWild) {
                        dateMatch = daysOfMonth.contains(candidate.getDayOfMonth()) && daysOfWeek.contains(candidate.getDayOfWeek().getValue());
                    } else if (!domWild) {
                        dateMatch = daysOfMonth.contains(candidate.getDayOfMonth());
                    } else if (!dowWild) {
                        dateMatch = daysOfWeek.contains(candidate.getDayOfWeek().getValue());
                    } else {
                        dateMatch = true;
                    }
                    if (!dateMatch) {
                        candidate = candidate.plusDays(1).withHour(0).withMinute(0).withSecond(0).withNano(0);
                    } else if (!hours.contains(candidate.getHour())) {
                        candidate = candidate.plusHours(1).withMinute(0).withSecond(0).withNano(0);
                    } else if (!minutes.contains(candidate.getMinute())) {
                        candidate = candidate.plusMinutes(1).withSecond(0).withNano(0);
                    } else {
                        candidate = candidate.plusSeconds(1);
                    }
                }
            }

            return -1;
        } catch (Exception e) {
            return -1;
        }
    }

    private static boolean matches(LocalDateTime dt,
                                   Set<Integer> seconds,
                                   Set<Integer> minutes,
                                   Set<Integer> hours,
                                   Set<Integer> daysOfMonth,
                                   Set<Integer> months,
                                   Set<Integer> daysOfWeek) {
        if (!seconds.contains(dt.getSecond())) return false;
        if (!minutes.contains(dt.getMinute())) return false;
        if (!hours.contains(dt.getHour())) return false;
        if (!months.contains(dt.getMonthValue())) return false;

        boolean domMatch = daysOfMonth.contains(dt.getDayOfMonth());
        boolean dowMatch = daysOfWeek.contains(dt.getDayOfWeek().getValue());

        boolean domWild = daysOfMonth.size() >= 31;
        boolean dowWild = daysOfWeek.size() >= 7;

        if (!domWild && !dowWild) {
            return domMatch && dowMatch;
        } else if (!domWild) {
            return domMatch;
        } else if (!dowWild) {
            return dowMatch;
        }
        return true;
    }

    static Set<Integer> parseField(String field, int min, int max) {
        Set<Integer> result = new HashSet<>();

        if (field.equals("*") || field.equals("?")) {
            for (int i = min; i <= max; i++) result.add(i);
            return result;
        }

        Matcher stepMatcher = STEP_PATTERN.matcher(field);
        if (stepMatcher.matches()) {
            int start = stepMatcher.group(1).equals("*") ? min : Integer.parseInt(stepMatcher.group(1));
            int step = Integer.parseInt(stepMatcher.group(2));
            if (step <= 0) throw new IllegalArgumentException("Cron step must be positive");
            for (int i = start; i <= max; i += step) {
                result.add(i);
            }
            return result;
        }

        for (String part : field.split(",")) {
            part = part.trim();
            Matcher rangeMatcher = RANGE_PATTERN.matcher(part);
            if (rangeMatcher.matches()) {
                int start = Integer.parseInt(rangeMatcher.group(1));
                int end = Integer.parseInt(rangeMatcher.group(2));
                for (int i = start; i <= end; i++) {
                    if (i >= min && i <= max) result.add(i);
                }
            } else if (part.equals("*") || part.equals("?")) {
                for (int i = min; i <= max; i++) result.add(i);
                return result;
            } else {
                int val = Integer.parseInt(part);
                if (val >= min && val <= max) result.add(val);
            }
        }

        return result;
    }

    static Set<Integer> parseDayOfWeekField(String field) {
        // 支持标准 cron 格式：0-7，0和7都是周日，1=周一
        Set<Integer> result = new HashSet<>();
        if (field.equals("*") || field.equals("?")) {
            for (int i = 1; i <= 7; i++) result.add(i); // ISO 全周
            return result;
        }

        for (String part : field.split(",")) {
            part = part.trim();
            if (part.equals("*") || part.equals("?")) {
                for (int i = 1; i <= 7; i++) result.add(i);
                return result;
            }
            // 处理范围和步长
            if (part.contains("/")) {
                String[] stepParts = part.split("/");
                int start = stepParts[0].equals("*") ? 0 : Integer.parseInt(stepParts[0]);
                int step = Integer.parseInt(stepParts[1]);
                if (step <= 0) throw new IllegalArgumentException("Cron step must be positive");
                for (int i = start; i <= 7; i += step) {
                    result.add(cronDowToIso(i));
                }
            } else if (part.contains("-")) {
                String[] rangeParts = part.split("-");
                int rs = Integer.parseInt(rangeParts[0]);
                int re = Integer.parseInt(rangeParts[1]);
                for (int i = rs; i <= re; i++) {
                    result.add(cronDowToIso(i));
                }
            } else {
                int val = Integer.parseInt(part);
                result.add(cronDowToIso(val));
            }
        }
        return result;
    }

    /**
     * 将 cron 星期值转换为 ISO 星期值（java.time DayOfWeek）。
     * cron: 0=周日, 1=周一, ..., 6=周六, 7=周日
     * ISO: 1=周一, ..., 7=周日
     */
    private static int cronDowToIso(int cronDow) {
        if (cronDow == 0 || cronDow == 7) return 7; // 周日
        return cronDow; // 1=周一, 2=周二, ..., 6=周六
    }
}
