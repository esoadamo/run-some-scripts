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

var uuid = crypto.randomUUID();

var addRuleBtn = document.getElementById("add-rule");
var applyBtn = document.getElementById("apply");
var exportBtn = document.getElementById("export-btn");
var importBtn = document.getElementById("import-btn");
var importFile = document.getElementById("import-file");
var statusLbl = document.getElementById("status");
var rulesContainer = document.getElementById("rules-container");
var versionLbl = document.getElementById("version");

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function send(id, data = null) {
    browser.runtime.sendMessage({
        "id": id,
        "initiator": uuid,
        "data": data
    });
}

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

function setComponentsDisabled(disabled) {
    addRuleBtn.disabled = disabled;
    applyBtn.disabled = disabled;
    exportBtn.disabled = disabled;
    importBtn.disabled = disabled;
    rulesContainer.querySelectorAll("input, textarea, button").forEach(function (el) {
        el.disabled = disabled;
    });
}

function setStatus(msg) {
    statusLbl.textContent = msg;
}

function notify(message) {
    var { id, initiator, data } = message;

    if (initiator !== uuid) {
        return;
    }

    switch (id) {
        case "get-ok":
            rulesContainer.innerHTML = "";
            (data.rules || []).forEach(function (rule) {
                createRuleCard(rule);
            });
            setComponentsDisabled(false);
            setStatus("");
            break;
        case "get-failed":
            setStatus(MESSAGES[data]);
            applyBtn.textContent = "Retry";
            applyBtn.disabled = false;
            break;
        case "set-ok":
            setComponentsDisabled(false);
            setStatus("Settings applied successfully.");
            break;
        case "set-failed":
            setComponentsDisabled(false);
            setStatus(MESSAGES[data]);
            break;
    }
}

function saveOptions() {
    setComponentsDisabled(true);
    setStatus("Applying settings...");
    send("set", { rules: collectRules() });
}

function restoreOptions() {
    setStatus("Loading persisted settings...");
    send("get");
}

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

function importRules() {
    importFile.click();
}

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
                // Ensure each imported rule has all required fields
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
    importFile.value = "";
});

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

browser.runtime.onMessage.addListener(notify);
document.addEventListener("DOMContentLoaded", restoreOptions);
versionLbl.textContent = "v" + browser.runtime.getManifest().version + " ";