const path = location.pathname;
document.getElementById("where").textContent = path.indexOf("/sidebar") >= 0
  ? "这个页面挂在侧栏「每日回顾」。"
  : path.indexOf("/menu/") >= 0
    ? "这个页面挂在设置菜单「关注点」。"
    : "这个页面挂在插件卡片的「设置」。";
const focus = document.getElementById("focus");
const status = document.getElementById("status");
loopra.ready.then(() => loopra.config.get()).then(value => {
  focus.value = value.focus || "";
}).catch(error => { status.textContent = error.message; });
document.getElementById("save").onclick = async () => {
  status.textContent = "保存中";
  status.className = "";
  try {
    const value = await loopra.config.set({ focus: focus.value.trim() });
    status.textContent = value.focus ? "已保存：" + value.focus : "已清空";
    status.className = "ok";
  } catch (error) {
    status.textContent = error.message || "没有连上 Loopra";
  }
};
