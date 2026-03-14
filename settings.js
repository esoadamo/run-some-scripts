/*
This file is part of run-a-script
Copyright (C) 2022-present Mihail Ivanchev

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program. If not, see <http://www.gnu.org/licenses/>.
*/

/*
 * SETTINGS PAGE SCRIPT — runs inside the browser_action popup and options_ui page.
 *
 * Responsibilities:
 *   1. On load, request the current rules from the background script ("get" message).
 *   2. Render a dynamic list of rule cards — one per injection rule.
 *   3. Let the user add, edit, delete, import, and export rules.
 *   4. On "Apply", collect all rules from the DOM and send them to the
 *      background script ("set" message) for persistence and re-registration.
 *
 * Communication:
 *   All data exchange with background.js happens via browser.runtime.sendMessage.
 *   Each settings page instance has a random UUID so it only processes replies
 *   addressed to it (multiple popups could theoretically be open).
 *
 * No data leaves the browser. The export feature creates a local JSON file
 * via a Blob URL; import reads a local file via FileReader. Neither touches
 * any network endpoint.
 */

/** @type {Object<string, string>} Maps error keys from background.js to user-facing messages. */
const MESSAGES = {
    "deactivate.script": "Failed to deactivate current scripts, settings not " +
        "persisted.",
    "persist.settings": "Failed to persist settings, no scripts currently " +
        "active.",
    "activate.script": "Failed to activate new scripts but settings persisted.",
    "query.settings": "Failed to retrieve persisted data, see the addon " +
        "inspector.",
    "validate.settings": "Failed to validate persistent settings, " +
        "see the addon inspector."
};

/**
 * Unique ID for this settings page instance.
 * Used to filter incoming messages — only process replies addressed to us.
 * @type {string}
 */
var uuid = crypto.randomUUID();

// --- DOM ELEMENT REFERENCES ---
/** @type {HTMLButtonElement} */ var addRuleBtn = document.getElementById("add-rule");
/** @type {HTMLButtonElement} */ var applyBtn = document.getElementById("apply");
/** @type {HTMLButtonElement} */ var exportBtn = document.getElementById("export-btn");
/** @type {HTMLButtonElement} */ var importBtn = document.getElementById("import-btn");
/** @type {HTMLInputElement}  */ var importFile = document.getElementById("import-file");
/** @type {HTMLSpanElement}   */ var statusLbl = document.getElementById("status");
/** @type {HTMLDivElement}    */ var rulesContainer = document.getElementById("rules-container");
/** @type {HTMLSpanElement}   */ var versionLbl = document.getElementById("version");

/**
 * Generate a short unique-enough identifier for a new rule.
 * Combines a base-36 timestamp with random characters.
 *
 * @returns {string} Alphanumeric ID (e.g. "lx1a2b3cde").
 */
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Send a message to the background script.
 * Automatically stamps the message with this page's UUID so the background
 * script can route the reply back to us.
 *
 * @param {string} id     - Message type ("get" or "set").
 * @param {*}      [data] - Optional payload (e.g. { rules: [...] } for "set").
 */
function send(id, data = null) {
    browser.runtime.sendMessage({
        "id": id,
        "initiator": uuid,
        "data": data
    });
}

/**
 * Create a DOM card element for one rule and append it to the rules container.
 *
 * Each card contains:
 *   - URL pattern input (glob syntax, default "*" = all URLs)
 *   - Checkboxes: Enabled, Inject jQuery, Inject GRenderer
 *   - Script textarea for user code
 *   - Delete button to remove the card from the DOM
 *
 * The rule's ID is stored in the card's data-rule-id attribute so
 * collectRules() can read it back when building the rules array.
 *
 * @param {Object}  rule                - Rule data to populate the card with.
 * @param {string}  rule.id             - Unique rule identifier.
 * @param {string}  rule.urlPattern     - URL glob pattern.
 * @param {string}  rule.script         - User JavaScript code.
 * @param {boolean} rule.enabled        - Whether the rule is active.
 * @param {boolean} rule.injectJquery   - Whether to inject jQuery.
 * @param {boolean} rule.injectGRenderer - Whether to inject GRenderer.
 * @returns {HTMLDivElement} The created card element.
 */
function createRuleCard(rule) {
    var card = document.createElement("div");
    card.className = "rule-card";
    card.dataset.ruleId = rule.id;

    var header = document.createElement("div");
    header.className = "rule-header";

    var patternLabel = document.createElement("label");
    patternLabel.textContent = "URL pattern: ";
    var patternInput = document.createElement("input");
    patternInput.type = "text";
    patternInput.className = "rule-url-pattern";
    patternInput.value = rule.urlPattern;
    patternInput.placeholder = "* (all URLs)";
    patternLabel.appendChild(patternInput);
    header.appendChild(patternLabel);

    var options = document.createElement("div");
    options.className = "rule-options";

    var enabledCb = createCheckbox("rule-enabled", "Enabled", rule.enabled);
    var jqueryCb = createCheckbox("rule-inject-jquery", "Inject jQuery", rule.injectJquery);
    var grenderCb = createCheckbox("rule-inject-grenderer", "Inject GRenderer", rule.injectGRenderer);
    options.appendChild(enabledCb);
    options.appendChild(jqueryCb);
    options.appendChild(grenderCb);

    var textarea = document.createElement("textarea");
    textarea.className = "rule-script";
    textarea.rows = 15;
    textarea.cols = 95;
    textarea.spellcheck = false;
    textarea.value = rule.script;
    textarea.placeholder = "// Your JavaScript code here...";

    var actions = document.createElement("div");
    actions.className = "rule-actions";
    var deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn-delete";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", function () {
        card.remove();
    });
    actions.appendChild(deleteBtn);

    card.appendChild(header);
    card.appendChild(options);
    card.appendChild(textarea);
    card.appendChild(actions);

    rulesContainer.appendChild(card);
    return card;
}

/**
 * Create a labeled checkbox element.
 *
 * @param {string}  className - CSS class applied to the <input> (used by collectRules).
 * @param {string}  label     - Human-readable label text shown next to the checkbox.
 * @param {boolean} checked   - Initial checked state.
 * @returns {HTMLLabelElement} A <label> wrapping the checkbox and its text.
 */
function createCheckbox(className, label, checked) {
    var wrapper = document.createElement("label");
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = className;
    cb.checked = checked;
    wrapper.appendChild(cb);
    wrapper.appendChild(document.createTextNode(" " + label));
    return wrapper;
}

/**
 * Read the current state of all rule cards from the DOM and return
 * them as a plain array of rule objects. This is the inverse of
 * createRuleCard() — it extracts values from the inputs/checkboxes.
 *
 * If the URL pattern field is empty, it defaults to "*" (all URLs).
 *
 * @returns {Object[]} Array of rule objects ready to be sent to background.js.
 */
function collectRules() {
    var rules = [];
    var cards = rulesContainer.querySelectorAll(".rule-card");
    cards.forEach(function (card) {
        rules.push({
            id: card.dataset.ruleId,
            urlPattern: card.querySelector(".rule-url-pattern").value || "*",
            script: card.querySelector(".rule-script").value,
            enabled: card.querySelector(".rule-enabled").checked,
            injectJquery: card.querySelector(".rule-inject-jquery").checked,
            injectGRenderer: card.querySelector(".rule-inject-grenderer").checked
        });
    });
    return rules;
}

/**
 * Enable or disable all interactive UI elements (buttons, inputs, textareas).
 * Used to lock the UI while an async operation is in progress.
 *
 * @param {boolean} disabled - True to disable all controls, false to enable.
 */
function setComponentsDisabled(disabled) {
    addRuleBtn.disabled = disabled;
    applyBtn.disabled = disabled;
    exportBtn.disabled = disabled;
    importBtn.disabled = disabled;
    rulesContainer.querySelectorAll("input, textarea, button").forEach(function (el) {
        el.disabled = disabled;
    });
}

/**
 * Update the status text shown in the toolbar.
 *
 * @param {string} msg - Status message to display (empty string to clear).
 */
function setStatus(msg) {
    statusLbl.textContent = msg;
}

/**
 * Message listener — handles replies from the background script.
 * Only processes messages whose initiator matches our UUID.
 *
 * Handled reply types:
 *   "get-ok"     — rules loaded successfully; render them as cards.
 *   "get-failed" — storage read failed; show error, offer retry.
 *   "set-ok"     — rules saved and registered; re-enable UI.
 *   "set-failed" — save or register failed; show error, re-enable UI.
 *
 * @param {Object} message            - Incoming message.
 * @param {string} message.id         - Reply type.
 * @param {string} message.initiator  - UUID of the intended recipient.
 * @param {*}      [message.data]     - Payload (settings or error key).
 */
function notify(message) {
    var { id, initiator, data } = message;

    // Ignore messages addressed to other settings page instances.
    if (initiator !== uuid) {
        return;
    }

    switch (id) {
        case "get-ok":
            // Clear old cards and render the loaded rules.
            rulesContainer.innerHTML = "";
            (data.rules || []).forEach(function (rule) {
                createRuleCard(rule);
            });
            setComponentsDisabled(false);
            setStatus("");
            break;
        case "get-failed":
            setStatus(MESSAGES[data] || "An unknown error occurred: " + data);
            applyBtn.textContent = "Retry";
            applyBtn.disabled = false;
            break;
        case "set-ok":
            setComponentsDisabled(false);
            setStatus("Settings applied successfully.");
            break;
        case "set-failed":
            setComponentsDisabled(false);
            setStatus(MESSAGES[data] || "An unknown error occurred: " + data);
            break;
    }
}

/**
 * Collect all rules from the DOM and send them to the background script
 * for persistence and re-registration. Locks the UI until a reply arrives.
 */
function saveOptions() {
    setComponentsDisabled(true);
    setStatus("Applying settings...");
    send("set", { rules: collectRules() });
}

/**
 * Request the current rules from the background script.
 * Called on page load and when the user clicks "Retry" after a failed load.
 */
function restoreOptions() {
    setStatus("Loading persisted settings...");
    send("get");
}

/**
 * Export the current rules as a JSON file download.
 * Creates a Blob URL, triggers a download via a temporary <a> element,
 * then revokes the URL. No network requests are made — everything is local.
 */
function exportRules() {
    var rules = collectRules();
    var blob = new Blob([JSON.stringify(rules, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "run-a-script-rules.json";
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Open the file picker for importing rules.
 * The actual import logic is in the "change" event handler on importFile.
 */
function importRules() {
    importFile.click();
}

/**
 * Handle file selection for import.
 * Reads the selected JSON file locally (no network), parses it, validates
 * that it's an array, fills in any missing fields with safe defaults, and
 * renders the imported rules as cards. The user must still click "Apply"
 * to actually persist and activate them.
 */
importFile.addEventListener("change", function () {
    var file = importFile.files[0];
    if (!file) return;

    var reader = new FileReader();
    reader.onload = function (e) {
        try {
            var rules = JSON.parse(e.target.result);
            if (!Array.isArray(rules)) {
                setStatus("Invalid import file: expected an array of rules.");
                return;
            }
            rulesContainer.innerHTML = "";
            rules.forEach(function (rule) {
                // Fill in missing fields with safe defaults so partial
                // exports or hand-edited JSON still work.
                createRuleCard({
                    id: rule.id || generateId(),
                    urlPattern: rule.urlPattern || "*",
                    script: rule.script || "",
                    enabled: rule.enabled !== false,
                    injectJquery: rule.injectJquery !== false,
                    injectGRenderer: !!rule.injectGRenderer
                });
            });
            setStatus("Rules imported. Click Apply to save.");
        } catch (err) {
            setStatus("Failed to parse import file: " + err.message);
        }
    };
    reader.readAsText(file);
    // Reset file input so re-selecting the same file triggers "change" again.
    importFile.value = "";
});

// --- EVENT LISTENERS ---

/** Add a new empty rule card with sensible defaults (all URLs, jQuery enabled). */
addRuleBtn.addEventListener("click", function () {
    createRuleCard({
        id: generateId(),
        urlPattern: "*",
        script: "",
        enabled: true,
        injectJquery: true,
        injectGRenderer: false
    });
});

applyBtn.addEventListener("click", saveOptions);
exportBtn.addEventListener("click", exportRules);
importBtn.addEventListener("click", importRules);

// --- INITIALIZATION ---
// Listen for replies from the background script.
browser.runtime.onMessage.addListener(notify);
// Load saved rules as soon as the DOM is ready.
document.addEventListener("DOMContentLoaded", restoreOptions);
versionLbl.textContent = "v" + browser.runtime.getManifest().version + " ";