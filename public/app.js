const API_BASE = "/api";

const openModalBtn = document.getElementById("openModalBtn");
const onboardModal = document.getElementById("onboardModal");
const cancelOnboardBtn = document.getElementById("cancelOnboardBtn");
const submitOnboardBtn = document.getElementById("submitOnboardBtn");
const repoUrlInput = document.getElementById("repoUrlInput");
const progressArea = document.getElementById("progressArea");
const progressStatus = document.getElementById("progressStatus");
const progressBarInner = document.getElementById("progressBarInner");
const progressError = document.getElementById("progressError");
const repoList = document.getElementById("repoList");
const repoListSection = document.getElementById("repoListSection");
const reportSection = document.getElementById("reportSection");
const reportContent = document.getElementById("reportContent");
const backBtn = document.getElementById("backBtn");
const chatMessages = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const chatSendBtn = document.getElementById("chatSendBtn");
const chatSources = document.getElementById("chatSources");

let pollTimer = null;
let currentRepoId = null;

openModalBtn.onclick = () => {
  onboardModal.classList.remove("hidden");
  progressArea.classList.add("hidden");
  progressError.classList.add("hidden");
  repoUrlInput.value = "";
  submitOnboardBtn.disabled = false;
};

cancelOnboardBtn.onclick = () => {
  onboardModal.classList.add("hidden");
  if (pollTimer) clearInterval(pollTimer);
};

backBtn.onclick = () => {
  reportSection.classList.add("hidden");
  repoListSection.classList.remove("hidden");
};

submitOnboardBtn.onclick = async () => {
  const repoUrl = repoUrlInput.value.trim();
  if (!repoUrl) return;

  progressArea.classList.remove("hidden");
  progressError.classList.add("hidden");
  submitOnboardBtn.disabled = true;
  progressStatus.textContent = "Submitting...";
  progressBarInner.style.width = "0%";

  try {
    const res = await fetch(`${API_BASE}/onboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to start onboarding");

    pollStatus(data.repoId);
  } catch (err) {
    progressError.textContent = err.message;
    progressError.classList.remove("hidden");
    submitOnboardBtn.disabled = false;
  }
};

function pollStatus(repoId) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${API_BASE}/repos/${repoId}/status`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Status check failed");

      progressBarInner.style.width = `${data.progress || 0}%`;
      progressStatus.textContent = data.currentAgent
        ? `${data.status} — ${data.currentAgent}`
        : data.status;

      if (data.status === "completed") {
        clearInterval(pollTimer);
        onboardModal.classList.add("hidden");
        await loadRepoList();
        openReport(repoId);
      } else if (data.status === "failed") {
        clearInterval(pollTimer);
        progressError.textContent = data.error || "Onboarding failed";
        progressError.classList.remove("hidden");
        submitOnboardBtn.disabled = false;
      }
    } catch (err) {
      clearInterval(pollTimer);
      progressError.textContent = err.message;
      progressError.classList.remove("hidden");
      submitOnboardBtn.disabled = false;
    }
  }, 2000);
}

async function loadRepoList() {
  try {
    const res = await fetch(`${API_BASE}/repos`);
    const repos = await res.json();
    repoList.innerHTML = "";
    repos.forEach((repo) => {
      const li = document.createElement("li");
      li.innerHTML = `<span>${repo.repoUrl}</span><span class="status-badge status-${repo.status}">${repo.status}</span>`;
      li.onclick = () => openReport(repo.repoId);
      repoList.appendChild(li);
    });
  } catch (err) {
    console.error("Failed to load repo list", err);
  }
}

async function openReport(repoId) {
  try {
    const res = await fetch(`${API_BASE}/repos/${repoId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load report");

    currentRepoId = repoId;
    repoListSection.classList.add("hidden");
    reportSection.classList.remove("hidden");
    reportContent.innerHTML = data.intakeReport
      ? marked.parse(data.intakeReport)
      : "<p>No intake report available yet.</p>";

    chatMessages.innerHTML = "";
    chatSources.innerHTML = "";
    chatInput.value = "";
  } catch (err) {
    alert(err.message);
  }
}

async function sendQuery() {
  const question = chatInput.value.trim();
  if (!question || !currentRepoId) return;

  addChatMessage("user", question);
  chatInput.disabled = true;
  chatSendBtn.disabled = true;
  chatSources.innerHTML = "";

  try {
    const res = await fetch(`${API_BASE}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoId: currentRepoId, question }),
    });
    const result = await res.json();

    if (res.ok) {
      addChatMessage(
        "assistant",
        marked.parse(result.answer || ""),
        result.sources,
        result.searchMethod
      );
      displaySources(result.sources, result.searchMethod, result.confidence);
    } else {
      addChatMessage("error", result.error || "Failed to get an answer.");
    }
  } catch (err) {
    addChatMessage("error", `Error: ${err.message}`);
  } finally {
    chatInput.disabled = false;
    chatSendBtn.disabled = false;
    chatInput.value = "";
    chatInput.focus();
  }
}

function addChatMessage(role, html, sources, searchMethod) {
  const msgDiv = document.createElement("div");
  msgDiv.className = `chat-msg ${role}`;
  msgDiv.innerHTML = html;

  if (sources && sources.length > 0) {
    const badgeWrap = document.createElement("div");
    badgeWrap.className = "citation-badges";
    const methodClass = searchMethod === "vector" ? "method-vector" : "method-grep";

    sources.forEach((s) => {
      const badge = document.createElement("span");
      badge.className = `citation-badge ${methodClass}`;
      badge.textContent = `${s.section} · ${Math.round((s.similarity || 0) * 100)}%`;
      badgeWrap.appendChild(badge);
    });

    msgDiv.appendChild(badgeWrap);
  }

  chatMessages.appendChild(msgDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}


function displaySources(sources, searchMethod, confidence) {
  if (!sources || sources.length === 0) {
    chatSources.innerHTML = "";
    return;
  }
  const methodLabel = searchMethod === "vector" ? "Vector Search" : "Code Search";
  const methodClass = searchMethod === "vector" ? "method-vector" : "method-grep";
  const conf = Math.round((confidence || 0) * 100);

  chatSources.innerHTML = `
    <strong class="${methodClass}">Sources (${methodLabel}, ${conf}% confidence):</strong><br/>
    ${sources
      .map(
        (s) =>
          `• ${s.section} (${Math.round((s.similarity || 0) * 100)}% match)`
      )
      .join("<br/>")}
  `;
}

chatSendBtn.onclick = sendQuery;
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendQuery();
});

loadRepoList();
