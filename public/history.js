// Elements
const historyBtn = document.getElementById("historyBtn");
const historyPanel = document.getElementById("historyPanel");
const historyBackdrop = document.getElementById("historyBackdrop");
const closeHistory = document.getElementById("closeHistory");
const historyList = document.getElementById("historyList");

function toggleHistory(open) {
  const isOpen = open ?? !historyPanel.classList.contains("open");
  historyPanel.classList.toggle("open", isOpen);
  historyBackdrop.classList.toggle("open", isOpen);
  document.body.style.overflow = isOpen ? "hidden" : "";
}

historyBtn?.addEventListener("click", () => toggleHistory());
closeHistory?.addEventListener("click", () => toggleHistory(false));
historyBackdrop?.addEventListener("click", () => toggleHistory(false));

// Sample data
const historyData = [
  { id: 1, title: "Woman On Sofa", size: "4.5 KB" },
  { id: 2, title: "Terrilynne Collins Final Render", size: "5.2 KB" },
  { id: 3, title: "Moment After Psychopath Song", size: "6.1 KB" },
];

// Render items
function renderHistory() {
  historyList.innerHTML = "";
  historyData.forEach(item => {
    const div = document.createElement("div");
    div.className = "history-item";
    div.innerHTML = `
      <div class="history-title">${item.title}</div>
      <button class="kebab-btn" title="Options">⋯</button>
      <div class="kebab-menu">
        <div class="size">Size: ${item.size}</div>
        <button data-action="rename">Rename</button>
        <button data-action="share">Share</button>
        <button data-action="delete">Delete</button>
      </div>
    `;
    const kebabBtn = div.querySelector(".kebab-btn");
    const kebabMenu = div.querySelector(".kebab-menu");

    // Floating, viewport-fixed menu like ChatGPT
    kebabBtn.addEventListener("click", (e) => {
      e.stopPropagation();

      // close other open menus
      document.querySelectorAll(".kebab-menu.open").forEach(m => {
        m.classList.remove("open");
        m.style.display = "";
        m.style.visibility = "";
      });

      const openNow = !kebabMenu.classList.contains("open");
      if (!openNow) {
        kebabMenu.classList.remove("open");
        return;
      }

      kebabMenu.classList.add("open");
      kebabMenu.style.position = "fixed";
      kebabMenu.style.display = "block";
      kebabMenu.style.visibility = "hidden";

      const btnRect = kebabBtn.getBoundingClientRect();
      const menuRect = kebabMenu.getBoundingClientRect();
      const margin = 10;
      const top = Math.min(window.innerHeight - menuRect.height - margin, btnRect.bottom + 6);
      const left = Math.min(window.innerWidth - menuRect.width - margin, Math.max(margin, btnRect.right - menuRect.width));

      kebabMenu.style.top = top + "px";
      kebabMenu.style.left = left + "px";
      kebabMenu.style.visibility = "visible";

      const closeAll = (ev) => {
        if (!kebabMenu.contains(ev.target) && ev.target !== kebabBtn) {
          kebabMenu.classList.remove("open");
          kebabMenu.style.display = "";
          kebabMenu.style.visibility = "";
          document.removeEventListener("click", closeAll);
        }
      };
      // defer binding to avoid immediate close from this click
      setTimeout(() => document.addEventListener("click", closeAll), 0);

      // also close on resize/scroll (one-shot)
      const onEnd = () => {
        kebabMenu.classList.remove("open");
        kebabMenu.style.display = "";
        kebabMenu.style.visibility = "";
        window.removeEventListener("resize", onEnd);
        window.removeEventListener("scroll", onEnd, true);
      };
      window.addEventListener("resize", onEnd, { once: true });
      window.addEventListener("scroll", onEnd, { once: true, capture: true });
    });

    // simple outside close if user clicks elsewhere while menu is open
    document.addEventListener("click", (ev) => {
      if (!div.contains(ev.target)) {
        kebabMenu.classList.remove("open");
        kebabMenu.style.display = "";
        kebabMenu.style.visibility = "";
      }
    });

    historyList.appendChild(div);
  });
}
renderHistory();
