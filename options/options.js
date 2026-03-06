/**
 * options.js — Settings page logic.
 *
 * Handles loading/saving API key and model selection to chrome.storage.local.
 * Validates the API key by calling GET /v1/models.
 */

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

let apiKeyInput, modelSelect, saveBtn, statusEl, toggleBtn;

document.addEventListener('DOMContentLoaded', () => {
  apiKeyInput = document.getElementById('api-key');
  modelSelect = document.getElementById('model');
  saveBtn = document.getElementById('save-btn');
  statusEl = document.getElementById('api-key-status');
  toggleBtn = document.getElementById('toggle-visibility');

  _loadSettings();

  document.getElementById('settings-form').addEventListener('submit', _onSave);
  toggleBtn.addEventListener('click', _toggleVisibility);
});

// ---------------------------------------------------------------------------
// Load saved settings
// ---------------------------------------------------------------------------

function _loadSettings() {
  chrome.storage.local.get(['openai_api_key', 'openai_model'], (result) => {
    if (result.openai_api_key) {
      apiKeyInput.value = result.openai_api_key;
    }
    if (result.openai_model) {
      modelSelect.value = result.openai_model;
    }
  });
}

// ---------------------------------------------------------------------------
// Save handler
// ---------------------------------------------------------------------------

async function _onSave(e) {
  e.preventDefault();

  const apiKey = apiKeyInput.value.trim();
  const model = modelSelect.value;

  // Basic client-side validation
  if (!apiKey) {
    _setStatus('error', '❌ Please enter an API key.');
    apiKeyInput.focus();
    return;
  }

  if (!apiKey.startsWith('sk-')) {
    _setStatus('error', '❌ API key must start with <code>sk-</code>.');
    apiKeyInput.focus();
    return;
  }

  _setStatus('loading', '⏳ Validating key…');
  saveBtn.disabled = true;

  const valid = await _validateApiKey(apiKey);

  if (!valid) {
    _setStatus('error', '❌ Invalid API key. Please check and try again.');
    saveBtn.disabled = false;
    apiKeyInput.focus();
    return;
  }

  chrome.storage.local.set({ openai_api_key: apiKey, openai_model: model }, () => {
    _setStatus('success', '✅ Settings saved successfully.');
    saveBtn.disabled = false;
  });
}

// ---------------------------------------------------------------------------
// API key validation
// ---------------------------------------------------------------------------

/**
 * Test the API key by calling GET /v1/models.
 * @param {string} apiKey
 * @returns {Promise<boolean>}
 */
async function _validateApiKey(apiKey) {
  try {
    const response = await fetch(OPENAI_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return response.ok;
  } catch (_err) {
    // Network error — treat as invalid (conservative)
    return false;
  }
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

/**
 * Update the status element.
 * @param {'loading'|'success'|'error'} type
 * @param {string} html
 */
function _setStatus(type, html) {
  statusEl.className = `status ${type}`;
  statusEl.innerHTML = html;
}

/**
 * Toggle API key input between password and text types.
 */
function _toggleVisibility() {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type = isPassword ? 'text' : 'password';
  toggleBtn.setAttribute('aria-label', isPassword ? 'Hide API key' : 'Show API key');
  toggleBtn.textContent = isPassword ? '🔒' : '👁';
}
