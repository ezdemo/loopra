package site.sorghum.loopra.web.service;

import site.sorghum.loopra.web.common.entity.ProcessResult;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/** Drains both pipes concurrently, bounds output and kills timed out Git processes. */
final class GitCommandRunner {
    private static final int MAX_GIT_OUTPUT_CHARS = 10 * 1024 * 1024;
    private static final int GIT_OUTPUT_DRAIN_TIMEOUT_SEC = 1;
    private static final ExecutorService GIT_IO_EXECUTOR = Executors.newCachedThreadPool(task -> {
        Thread thread = new Thread(task, "loopra-git-io");
        thread.setDaemon(true);
        return thread;
    });

    private GitCommandRunner() {
    }

    static ProcessResult run(File workDir, long timeoutSec, String... command) throws Exception {
        ProcessBuilder pb = new ProcessBuilder(command);
        pb.directory(workDir);
        pb.redirectErrorStream(false);
        pb.environment().put("GIT_TERMINAL_PROMPT", "0");

        Process proc = pb.start();
        Future<String> stdout = GIT_IO_EXECUTOR.submit(() -> readStream(proc.getInputStream()));
        Future<String> stderr = GIT_IO_EXECUTOR.submit(() -> readStream(proc.getErrorStream()));
        try {
            boolean finished = proc.waitFor(timeoutSec, TimeUnit.SECONDS);
            if (!finished) {
                proc.destroyForcibly();
                proc.waitFor();
                return processResult(-1, "", "Command timed out after " + timeoutSec + " seconds");
            }

            return processResult(proc.exitValue(), awaitOutput(stdout), awaitOutput(stderr));
        } finally {
            if (proc.isAlive()) {
                proc.destroyForcibly();
            }
            stdout.cancel(true);
            stderr.cancel(true);
        }
    }

    private static ProcessResult processResult(int exitCode, String stdout, String stderr) {
        ProcessResult result = new ProcessResult();
        result.exitCode = exitCode;
        result.stdout = stdout;
        result.stderr = stderr;
        return result;
    }

    private static String awaitOutput(Future<String> output) throws Exception {
        return output.get(GIT_OUTPUT_DRAIN_TIMEOUT_SEC, TimeUnit.SECONDS);
    }

    private static String readStream(InputStream input) throws IOException {
        StringBuilder output = new StringBuilder();
        try (input) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                String chunk = new String(buffer, 0, read, StandardCharsets.UTF_8);
                int remaining = MAX_GIT_OUTPUT_CHARS - output.length();
                if (remaining > 0) {
                    output.append(chunk, 0, Math.min(remaining, chunk.length()));
                }
            }
        }
        if (output.length() >= MAX_GIT_OUTPUT_CHARS) {
            output.append("\n... (Git output truncated)");
        }
        return output.toString();
    }
}
