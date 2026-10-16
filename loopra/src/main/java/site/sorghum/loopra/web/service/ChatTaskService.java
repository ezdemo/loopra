package site.sorghum.loopra.web.service;

import lombok.extern.slf4j.Slf4j;
import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Destroy;
import org.noear.solon.annotation.Inject;
import site.sorghum.loopra.web.common.ServiceException;

import java.util.Objects;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.FutureTask;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/**
 * 拥有聊天后台任务的排队、取消与资源释放。
 * 每个任务的 Future、会话身份与完成回调放在一起；运行中的任务在退出后才关闭输出。
 */
@Slf4j
@Component
public class ChatTaskService {

    private static final long CANCEL_MARKER_TTL_MS = TimeUnit.MINUTES.toMillis(5);
    private static final int MAX_CANCEL_MARKERS = 1024;

    private final ExecutorService executor;
    private final LongSupplier clock;
    private final ConcurrentHashMap<String, Task> tasks = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Long> cancelledRequests = new ConcurrentHashMap<>();

    @Inject
    private AgentService agentService;

    public ChatTaskService() {
        this(newExecutor(), null, System::currentTimeMillis);
    }

    ChatTaskService(ExecutorService executor, AgentService agentService, LongSupplier clock) {
        this.executor = executor;
        this.agentService = agentService;
        this.clock = clock;
    }

    private static ExecutorService newExecutor() {
        AtomicInteger counter = new AtomicInteger();
        return new ThreadPoolExecutor(16, 16, 0, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(64), runnable -> {
                    Thread thread = new Thread(runnable, "loopra-chat-stream-" + counter.incrementAndGet());
                    thread.setDaemon(true);
                    return thread;
                }, new ThreadPoolExecutor.AbortPolicy());
    }

    /** 注册先于入队，使等待线程的聊天也能被查询和取消。 */
    public synchronized void submit(String requestId, String workspacePath, String sessionName,
                                    Runnable operation, Consumer<ServiceException> completion) {
        Objects.requireNonNull(requestId, "requestId");
        if (requestId.isBlank()) throw new ServiceException("requestId 不能为空");
        cleanupCancelMarkers();
        if (tasks.containsKey(requestId)) {
            throw new ServiceException(409, "requestId 已有正在处理的聊天任务");
        }
        Task task = new Task(requestId, workspacePath, sessionName, operation, completion);
        agentService.registerSessionTask(workspacePath, sessionName, requestId);
        tasks.put(requestId, task);
        if (cancelledRequests.remove(requestId) != null) {
            task.cancel();
            return;
        }
        try {
            executor.execute(task);
        } catch (RejectedExecutionException exception) {
            ServiceException rejection = new ServiceException(503, "聊天任务已满，请稍后重试");
            task.future.cancel(false);
            task.finish(rejection);
            throw rejection;
        }
    }

    /** 尚未登记的取消请求短暂保留，用于处理 HTTP 请求到达顺序不同的情况。 */
    public synchronized void cancel(String requestId) {
        if (requestId == null || requestId.isBlank()) return;
        cleanupCancelMarkers();
        Task task = tasks.get(requestId);
        if (task != null) {
            task.cancel();
            return;
        }
        if (cancelledRequests.size() >= MAX_CANCEL_MARKERS) {
            cancelledRequests.entrySet().stream().min(Map.Entry.comparingByValue())
                    .ifPresent(entry -> cancelledRequests.remove(entry.getKey(), entry.getValue()));
        }
        cancelledRequests.put(requestId, clock.getAsLong());
    }

    private void cleanupCancelMarkers() {
        long cutoff = clock.getAsLong() - CANCEL_MARKER_TTL_MS;
        cancelledRequests.entrySet().removeIf(entry -> entry.getValue() < cutoff);
    }

    @Destroy
    public synchronized void close() {
        executor.shutdownNow();
        tasks.values().forEach(Task::cancel);
        cancelledRequests.clear();
    }

    private final class Task implements Runnable {
        private final String requestId;
        private final String workspacePath;
        private final String sessionName;
        private final Consumer<ServiceException> completion;
        private final FutureTask<Void> future;
        private final AtomicBoolean finished = new AtomicBoolean();
        private boolean started;

        Task(String requestId, String workspacePath, String sessionName,
             Runnable operation, Consumer<ServiceException> completion) {
            this.requestId = requestId;
            this.workspacePath = workspacePath;
            this.sessionName = sessionName;
            this.completion = Objects.requireNonNull(completion, "completion");
            this.future = new FutureTask<>(Objects.requireNonNull(operation, "operation"), null);
        }

        @Override
        public void run() {
            synchronized (this) {
                if (future.isCancelled()) return;
                started = true;
            }
            try {
                future.run();
            } finally {
                finish(null);
            }
        }

        void cancel() {
            boolean closeNow;
            synchronized (this) {
                future.cancel(true);
                closeNow = !started;
            }
            if (executor instanceof ThreadPoolExecutor pool) pool.remove(this);
            if (closeNow) finish(null);
        }

        private void finish(ServiceException failure) {
            if (!finished.compareAndSet(false, true)) return;
            try {
                // Keep the registration until running work has actually left its finally blocks.
                agentService.unregisterSessionTask(workspacePath, sessionName, requestId);
            } finally {
                tasks.remove(requestId, this);
                try {
                    completion.accept(failure);
                } catch (Exception exception) {
                    log.debug("[chat] 关闭流输出失败: requestId={}", requestId, exception);
                }
            }
        }
    }
}
