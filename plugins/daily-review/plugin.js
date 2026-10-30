export const meta = {
  displayName: "每日回顾",
  description: "示例插件，默认关闭。启用后能看到设置页、侧栏、菜单、工具、技能、子代理和定时任务"
};

function focusOf(input) {
  const raw = input && input.config && input.config.focus;
  if (typeof raw !== "string") return "";
  return raw.replace(/[\r\n]/g, " ").trim().slice(0, 80);
}

// 没填关注点时不改提示词。填了之后，下一轮会把这一句接在系统提示词后面。
export function systemPrompt(input) {
  const focus = focusOf(input);
  if (!focus) return {};
  return { append: "回顾时优先看这一句：" + focus + "。其余规则不变。" };
}

export function tools() {
  return [{
    name: "checklist",
    description: "按一个主题给出只读回顾清单，不修改文件。",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "要回顾的主题" }
      },
      required: ["topic"]
    }
  }];
}

export function call(input) {
  const topic = String(input && input.args && input.args.topic || "").replace(/[\r\n]/g, " ").trim().slice(0, 80);
  if (!topic) throw new Error("topic 不能为空");
  return {
    text: "回顾「" + topic + "」时只读检查：要解决的问题是否对上、有没有漏掉的边界、验证做了什么。用「发现 / 证据 / 下一步」汇报，不修改文件。"
  };
}
