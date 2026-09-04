interface OptionsState {
  config: {
    wsUrl: string;
    heartbeatMs: number;
  };
  connection: {
    state: string;
    lastConnectedAt?: number;
    lastError?: string;
    lastInfo?: string;
  };
  tabs: Array<{
    tabID: string;
    title?: string;
    url?: string;
    active: boolean;
    injectable?: boolean;
    executorReady?: boolean;
    restrictedReason?: string;
  }>;
}

const statusNode = document.querySelector<HTMLParagraphElement>("#status");
const wsUrlInput = document.querySelector<HTMLInputElement>("#wsUrl");
const heartbeatInput = document.querySelector<HTMLInputElement>("#heartbeatMs");
const tabsNode = document.querySelector<HTMLUListElement>("#tabs");
const saveButton = document.querySelector<HTMLButtonElement>("#save");

async function getState(): Promise<OptionsState> {
  return (await chrome.runtime.sendMessage({ type: "pi-browser:options:get-state" })) as OptionsState;
}

async function saveState(): Promise<void> {
  if (!wsUrlInput || !heartbeatInput) {
    return;
  }
  const response = await chrome.runtime.sendMessage({
    type: "pi-browser:options:save-config",
    config: {
      wsUrl: wsUrlInput.value,
      heartbeatMs: Number.parseInt(heartbeatInput.value, 10),
    },
  });
  if (response?.error) {
    renderStatus(`保存失败: ${response.error}`);
    return;
  }
  render(await getState());
  renderStatus("已保存");
}

function renderStatus(text: string): void {
  if (statusNode) {
    statusNode.textContent = text;
  }
}

function render(state: OptionsState): void {
  if (wsUrlInput) {
    wsUrlInput.value = state.config.wsUrl;
  }
  if (heartbeatInput) {
    heartbeatInput.value = String(state.config.heartbeatMs);
  }
  renderStatus(
    `连接状态: ${state.connection.state}${state.connection.lastInfo ? ` | ${state.connection.lastInfo}` : ""}${state.connection.lastError ? ` | 错误: ${state.connection.lastError}` : ""}${
      state.connection.lastConnectedAt ? ` | 最近连接: ${new Date(state.connection.lastConnectedAt).toLocaleString()}` : ""
    }`,
  );
  if (tabsNode) {
    tabsNode.innerHTML = "";
    for (const tab of state.tabs) {
      const item = document.createElement("li");
      item.textContent = `${tab.active ? "* " : ""}[${tab.tabID}] ${tab.title ?? "(untitled)"} | executor=${tab.executorReady ? "ready" : "missing"} | injectable=${tab.injectable ? "yes" : "no"}${tab.restrictedReason ? ` | ${tab.restrictedReason}` : ""}`;
      if (tab.url) {
        const url = document.createElement("div");
        url.textContent = tab.url;
        item.appendChild(url);
      }
      tabsNode.appendChild(item);
    }
  }
}

saveButton?.addEventListener("click", () => {
  void saveState();
});

void getState().then(render);
