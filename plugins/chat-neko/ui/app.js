const name = document.getElementById("name");
const status = document.getElementById("status");
loopra.ready.then(() => loopra.config.get()).then(value => {
  name.value = value.nickname || "";
}).catch(error => { status.textContent = error.message; });
document.getElementById("save").onclick = async () => {
  status.textContent = "保存中";
  status.className = "";
  try {
    const value = await loopra.config.set({ nickname: name.value.trim() });
    status.textContent = value.nickname ? "已保存：" + value.nickname : "已保存";
    status.className = "ok";
  } catch (error) {
    status.textContent = error.message || "没有连上 Loopra";
  }
};
