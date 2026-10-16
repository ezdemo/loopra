package site.sorghum.loopra.bin.agent.core;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import site.sorghum.loopra.bin.agent.context.ConversationContext;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.agent.prompt.PromptPrefix;
import site.sorghum.loopra.bin.agent.prompt.StateNoticeRenderer;
import site.sorghum.loopra.bin.model.TestLoopraProvider;
import site.sorghum.loopra.bin.tool.ToolRegistry;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 折叠后清理陈旧状态通知：只保留最新一条。
 * <p>
 * 放任堆积会让每轮模型调用都把历史里的旧 Goal 全文重复读一遍；
 * 判定必须足够精确 —— 折叠摘要也是 user 消息，不能被误删。
 * </p>
 */
class StateNoticePruneTest {

    private static AgentLoop loopWith(ConversationContext context) {
        return new AgentLoop(TestLoopraProvider.builder()
                .call(request -> TestLoopraProvider.response("ok"))
                .contextTokens(1000)
                .build(), new ToolRegistry().setDisabledTools(Set.of()), context, null);
    }

    private static ConversationContext newContext() {
        return new ConversationContext(new PromptPrefix("system", new ONode().asArray()));
    }

    private static int countNotices(List<ChatMessage> history) {
        return (int) history.stream()
                .filter(m -> m.isUser() && m.isWebHidden() && StateNoticeRenderer.isNotice(m.getContent()))
                .count();
    }

    @Test
    void keepsOnlyLatestStateNotice() {
        ConversationContext context = newContext();
        context.addUser("用户消息 1");
        context.addSystemNotice(StateNoticeRenderer.render("goal A"));
        context.addAssistant("回复", null, null);
        context.addSystemNotice(StateNoticeRenderer.render("goal B"));
        context.addUser("用户消息 2");
        context.addSystemNotice(StateNoticeRenderer.render("goal C"));
        context.addUser("用户消息 3");

        ContextCompactor compactor = new ContextCompactor(loopWith(context));
        int removed = compactor.pruneStaleStateNotices();

        assertEquals(2, removed, "应裁掉两条陈旧通知");
        List<ChatMessage> history = context.getHistory();
        assertEquals(1, countNotices(history), "只应保留最新一条通知");

        String kept = history.stream()
                .filter(m -> m.isUser() && m.isWebHidden() && StateNoticeRenderer.isNotice(m.getContent()))
                .findFirst()
                .orElseThrow()
                .getContent();
        assertEquals(StateNoticeRenderer.render("goal C"), kept, "保留的必须是最新那条（步骤未回退）");

        // 非通知消息一条都不能少，且相对顺序不变
        assertEquals(4, history.size() - countNotices(history), "普通消息应全部保留");
        assertEquals("用户消息 1", history.get(0).getContent());
        assertEquals("用户消息 3", history.get(history.size() - 1).getContent());
    }

    @Test
    void singleNoticeIsNoOp() {
        ConversationContext context = newContext();
        context.addUser("用户消息");
        context.addSystemNotice(StateNoticeRenderer.render("goal A"));
        context.addUser("用户消息 2");
        int before = context.size();

        int removed = new ContextCompactor(loopWith(context)).pruneStaleStateNotices();

        assertEquals(0, removed);
        assertEquals(before, context.size());
    }

    @Test
    void noNoticeIsNoOp() {
        ConversationContext context = newContext();
        context.addUser("用户消息 1");
        context.addAssistant("回复", null, null);
        context.addUser("用户消息 2");
        int before = context.size();

        int removed = new ContextCompactor(loopWith(context)).pruneStaleStateNotices();

        assertEquals(0, removed);
        assertEquals(before, context.size());
    }

    /**
     * 谓词必须精确：只带 webHidden、但内容不是状态通知的消息（例如别处的隐藏提醒）
     * 不得被当成陈旧通知删掉。
     */
    @Test
    void ignoresWebHiddenMessagesThatAreNotNotices() {
        ConversationContext context = newContext();
        context.addSystemNotice(StateNoticeRenderer.render("goal A"));
        UserMessage foreign = UserMessage.of("另一条隐藏提醒，不是状态通知");
        foreign.setWebHidden(true);
        context.addUser(foreign);
        context.addSystemNotice(StateNoticeRenderer.render("goal B"));

        ContextCompactor compactor = new ContextCompactor(loopWith(context));
        int removed = compactor.pruneStaleStateNotices();

        assertEquals(1, removed, "只应裁掉那条陈旧状态通知");
        assertTrue(context.getHistory().stream()
                        .anyMatch(m -> "另一条隐藏提醒，不是状态通知".equals(m.getContent())),
                "非状态通知的 webHidden 消息必须保留");
    }

    /**
     * 折叠摘要也是 user 消息（{@code ChatMessage.ofUser}），但它不带 webHidden ——
     * 即便摘要正文里引用了信封字面量，也不能被当成通知删掉。
     */
    @Test
    void neverDeletesFoldSummaryEvenIfItQuotesTheEnvelope() {
        ConversationContext context = newContext();
        context.addSystemNotice(StateNoticeRenderer.render("goal A"));
        context.addUser("[历史上下文折叠——以下 3 条较早消息已被摘要]\n"
                + "其中一条是 <system-reminder source=\"loopra-state\" fingerprint=\"deadbeef\"> 开头的提醒。");
        context.addSystemNotice(StateNoticeRenderer.render("goal B"));

        int removed = new ContextCompactor(loopWith(context)).pruneStaleStateNotices();

        assertEquals(1, removed);
        assertTrue(context.getHistory().stream()
                        .anyMatch(m -> m.getContent() != null && m.getContent().startsWith("[历史上下文折叠")),
                "折叠摘要必须保留");
    }
}
