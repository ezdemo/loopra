export const meta = { displayName: "你好" };

export function tools() {
  return [{
    name: "greet",
    description: "向指定的人打招呼",
    readOnly: true,
    parameters: { type: "object", properties: { name: { type: "string" } } }
  }];
}

export function call(input) {
  return { text: "你好，" + (input.args.name || "世界") };
}
