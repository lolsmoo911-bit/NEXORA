const ratesBody = document.getElementById("rates");
const statusEl = document.getElementById("status");
const receivedEl = document.getElementById("received");
const disclaimerEl = document.getElementById("disclaimer");
const refreshButton = document.getElementById("refresh");

function cell(text, className) {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function attributionText(rate) {
  const keys = rate.provider_keys || [];
  if (keys.length === 0) {
    return `${rate.source_name} — provider metadata: ${rate.provider_metadata_status || "UNKNOWN"}`;
  }
  const shown = keys.slice(0, 6).join(", ");
  const extra = keys.length > 6 ? ` +${keys.length - 6} more` : "";
  return `${rate.source_name} — contributors: ${shown}${extra}`;
}

function qualityCell(rate) {
  const status = rate.quality_status || "UNKNOWN";
  const age = typeof rate.age_days === "number" ? ` · ${rate.age_days}d` : "";
  return cell(`${status}${age}`, `quality quality-${status.toLowerCase()}`);
}

function render(payload) {
  ratesBody.replaceChildren();
  if (!payload.rates || payload.rates.length === 0) {
    const row = document.createElement("tr");
    const empty = cell("No stored observations. Run `python run.py fetch`.", "empty");
    empty.colSpan = 6;
    row.appendChild(empty);
    ratesBody.appendChild(row);
  } else {
    for (const rate of payload.rates) {
      const row = document.createElement("tr");
      row.appendChild(cell(`${rate.base}/${rate.quote}`));
      row.appendChild(cell(rate.rate, "num mono"));
      row.appendChild(cell(rate.observation_date));
      const statusCell = cell(rate.data_status);
      statusCell.className = "status-pill";
      row.appendChild(statusCell);
      row.appendChild(qualityCell(rate));
      row.appendChild(cell(attributionText(rate), "attribution"));
      ratesBody.appendChild(row);
    }
  }

  statusEl.textContent = `${payload.count} observation(s) · ${payload.data_status} · ${payload.price_type} · non-executable · quality as of ${payload.as_of}`;
  const newest = payload.rates && payload.rates.length ? payload.rates[0].received_at : "—";
  receivedEl.textContent = `Last received (UTC): ${newest}`;
  disclaimerEl.textContent = payload.disclaimer || "";
}

async function load() {
  refreshButton.disabled = true;
  statusEl.textContent = "Loading…";
  try {
    const response = await fetch("/api/v1/fx/rates?limit=100", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    ratesBody.replaceChildren();
    const row = document.createElement("tr");
    const message = cell(`Could not load rates: ${error.message}`, "empty");
    message.colSpan = 6;
    row.appendChild(message);
    ratesBody.appendChild(row);
    statusEl.textContent = "Unavailable";
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", load);
load();
