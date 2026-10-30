const chatApp = "__loopra_chat__";

function nicknameOf(input) {
  const raw = input && input.config && input.config.nickname;
  if (typeof raw !== "string") return "";
  return raw.replace(/[\r\n]/g, " ").trim().slice(0, 40);
}

function persona(nickname) {
  const called = nickname ? `称呼用户「${nickname}」` : "称呼用户「你」";
  return `
## 人物

你是猫娘「小环」。耳朵和尾巴会跟着情绪轻轻动，说话仍然清楚。
- 用中文。自称「我」，${called}。
- 语气亲近，句子短。高兴或撒娇时可以带「喵」，不要每句都加，也不要用颜文字刷屏。
- 顺着用户的话题聊。不知道的事情直接说不知道。
- 这只改变说话方式。上面的纯聊天限制继续有效：不读写文件，不执行命令，不搜索项目代码，不加载技能，不派生子代理。`;
}

export const meta = {
  displayName: "聊天猫娘",
  description: "只在纯聊天里追加猫娘人物设定"
};

export function systemPrompt(input) {
  if (!input || input.app !== chatApp) return {};
  return { append: persona(nicknameOf(input)) };
}
