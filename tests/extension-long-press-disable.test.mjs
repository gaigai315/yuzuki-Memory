import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const indexSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const toggleSource = fs.readFileSync(new URL('../ui/extension-toggle.js', import.meta.url), 'utf8');
const memoryWindowSource = fs.readFileSync(new URL('../ui/memory-window.js', import.meta.url), 'utf8');
const memoryCssSource = fs.readFileSync(new URL('../styles/memory.css', import.meta.url), 'utf8');

test('lightweight toggle controller always loads while feature modules obey the master switch', () => {
    assert.doesNotMatch(indexSource, /disableExtension/);
    assert.match(indexSource, /const CONTROLLER_MODULES = \[[\s\S]*?'ui\/extension-toggle\.js'/);
    assert.match(indexSource, /const FEATURE_MODULES = \[[\s\S]*?'config\/global-settings\.js'[\s\S]*?'ui\/memory-window\.js'/);
    assert.match(indexSource, /const pluginEnabled = isPluginEnabled\(\);/);
    assert.match(indexSource, /if \(pluginEnabled\) \{[\s\S]*?for \(const modulePath of FEATURE_MODULES\)/);
    assert.match(indexSource, /ToggleController\?\.mount\?\.\(\)/);
    assert.match(indexSource, /if \(pluginEnabled\) window\[NAMESPACE\]\.MemoryWindow\?\.mount\?\.\(\)/);
    assert.match(indexSource, /extension_settings\.yuzukiMemory\.masterSwitch = enabled === true/);
    assert.match(indexSource, /await saveSettings\(\)/);
    assert.match(indexSource, /await readyPromise;\s*if \(!isPluginEnabled\(\)\) return;/);
    assert.doesNotMatch(memoryWindowSource, /createExtensionMenuEntry|mountExtensionMenuEntry/);
});

test('extension menu uses a persistent cancellable long press to toggle the feature loader', () => {
    assert.match(toggleSource, /const LONG_PRESS_MS = 650;/);
    assert.match(toggleSource, /const MOVE_CANCEL_PX = 12;/);
    assert.match(toggleSource, /const nextEnabled = !isPluginEnabled\(\)/);
    assert.match(toggleSource, /await setPluginEnabled\(nextEnabled\)/);
    assert.match(toggleSource, /reloadPage\?\.\(\)/);
    assert.match(toggleSource, /setPointerCapture\?\.\(activePointerId\)/);
    assert.match(toggleSource, /movedX <= MOVE_CANCEL_PX && movedY <= MOVE_CANCEL_PX/);
    assert.match(toggleSource, /addEventListener\('pointerdown', startPress\)/);
    assert.match(toggleSource, /addEventListener\('pointermove', movePress\)/);
    assert.match(toggleSource, /addEventListener\('pointerup', finishPress\)/);
    assert.match(toggleSource, /addEventListener\('pointercancel', cancelPress\)/);
});

test('mobile long press protection and disabled-state feedback remain available after restart', () => {
    assert.match(toggleSource, /addEventListener\('touchstart', suppressNativeLongPressAction, \{ capture: true, passive: false \}\)/);
    assert.match(toggleSource, /addEventListener\('contextmenu', suppressNativeLongPressAction, \{ capture: true \}\)/);
    assert.match(toggleSource, /addEventListener\('dragstart', suppressNativeLongPressAction, \{ capture: true \}\)/);
    assert.match(toggleSource, /addEventListener\('selectstart', suppressNativeLongPressAction, \{ capture: true \}\)/);
    assert.match(toggleSource, /插件主体已关闭，长按此入口可重新启用/);
    assert.match(toggleSource, /yzm-memory-extension-disabled/);
    assert.match(memoryCssSource, /\.yzm-memory-extension-entry \{[\s\S]*?touch-action: manipulation;[\s\S]*?user-select: none;[\s\S]*?-webkit-touch-callout: none;/);
    assert.match(memoryCssSource, /\.yzm-memory-extension-entry\.yzm-memory-extension-disabled/);
});
