const input = document.getElementById("server");
const status = document.getElementById("status");

chrome.storage.sync.get({ server: "http://localhost:7777" }).then(({ server }) => {
  input.value = server;
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.sync.set({ server: input.value.trim() });
  status.textContent = "Saved";
});
