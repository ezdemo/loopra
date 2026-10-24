package site.sorghum.loopra.web.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/** Phase-only diagnostics: never include workspace paths, session content or configuration values. */
final class AcpStartupTiming implements AutoCloseable {
    private static final Logger log = LoggerFactory.getLogger(AcpStartupTiming.class);
    private static final AtomicLong IDS = new AtomicLong();
    private final long id = IDS.incrementAndGet();
    private final String agent;
    private final String operation;
    private final long started = System.nanoTime();
    private final Map<String, Long> phases = new LinkedHashMap<>();
    private boolean cold;
    private boolean adapterReused;
    private boolean success;

    AcpStartupTiming(String agent, String operation) {
        this.agent = agent;
        this.operation = operation;
    }

    void cold() { cold = true; }
    void adapterReused() { adapterReused = true; }
    void success() { success = true; }

    static Step step(AcpStartupTiming timing, String name) { return new Step(timing, name); }

    private synchronized void record(String name, long nanos) { phases.merge(name, nanos, Long::sum); }

    @Override public synchronized void close() {
        long totalMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        Map<String, Long> millis = new LinkedHashMap<>();
        phases.forEach((name, nanos) -> millis.put(name, TimeUnit.NANOSECONDS.toMillis(nanos)));
        // Most warmed reads finish in a few milliseconds; keep normal logs focused on startup and failures.
        String format = "[acp-startup] trace={} agent={} operation={} cold={} adapterReused={} success={} totalMs={} phasesMs={}";
        if (cold || !success || totalMs >= 1000) log.info(format, id, agent, operation, cold, adapterReused, success, totalMs, millis);
        else log.debug(format, id, agent, operation, cold, adapterReused, success, totalMs, millis);
    }

    static final class Step implements AutoCloseable {
        private final AcpStartupTiming timing;
        private final String name;
        private final long started;

        private Step(AcpStartupTiming timing, String name) {
            this.timing = timing;
            this.name = name;
            started = timing == null ? 0 : System.nanoTime();
        }

        @Override public void close() {
            if (timing != null) timing.record(name, System.nanoTime() - started);
        }
    }
}
