import { useNavigationStore, useShellStore, useTerminalStore } from './store';

type AgentLocator = {
  selector?: string | null;
  text?: string | null;
  partialText?: string | null;
  x?: number | null;
  y?: number | null;
};

type AgentTypeRequest = {
  selector?: string | null;
  text: string;
  submit?: boolean;
};

type TerminalDebugApi = {
  summary: () => Record<string, unknown>;
  visibleRows: () => Array<{ index: number; text: string }>;
};

declare global {
  interface Window {
    __reverieAgent?: ReturnType<typeof createAgentApi>;
  }
}

export function maybeInstallAgentAutomation() {
  if (!import.meta.env.DEV) return;
  if (typeof window === 'undefined') return;
  const enabled = new URLSearchParams(window.location.search).get('agentAutomation') === '1';
  if (!enabled) return;
  window.__reverieAgent = createAgentApi();
}

function createAgentApi() {
  return {
    snapshot,
    domSnapshot,
    terminalSnapshot,
    activeTerminalId,
    activeElement,
    click,
    typeText,
  };
}

function snapshot() {
  return {
    title: document.title,
    location: window.location.href,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    shell: useShellStore.getState().shell,
    navigation: serializeNavigation(),
    terminal: terminalSnapshot(),
    dom: domSnapshot(),
  };
}

function serializeNavigation() {
  const nav = useNavigationStore.getState();
  return {
    selectedProjectId: nav.selectedProjectId,
    selectedFocusId: nav.selectedFocusId,
    selectedSessionId: nav.selectedSessionId,
    surfaceMode: nav.surfaceMode,
    creationMode: nav.creationMode,
    collapsedProjectIds: Array.from(nav.collapsedProjectIds),
    expandedFocusIds: Array.from(nav.expandedFocusIds),
    generalCollapsed: nav.generalCollapsed,
    hydrated: nav.hydrated,
  };
}

function terminalSnapshot() {
  const terminalStore = useTerminalStore.getState();
  const debug = terminalDebugApi();
  return {
    available: Boolean(debug),
    activeTerminalId: terminalStore.activeTerminalId,
    runningSessionId: terminalStore.runningSessionId,
    launchingSessionId: terminalStore.launchingSessionId,
    terminalInputArmed: terminalStore.terminalInputArmed,
    terminalSurface: terminalStore.terminalSurface,
    terminalScroll: terminalStore.terminalScroll,
    terminalLiveFollow: terminalStore.terminalLiveFollow,
    sessionTerminalBindings: terminalStore.sessionTerminalBindings,
    summary: debug?.summary() ?? null,
    visibleRows: debug?.visibleRows() ?? [],
  };
}

function activeTerminalId() {
  return useTerminalStore.getState().activeTerminalId;
}

function activeElement() {
  const element = document.activeElement;
  if (!element) return null;
  return describeElement(element as HTMLElement);
}

function domSnapshot() {
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>(
      [
        'button',
        '[role]',
        'input',
        'textarea',
        'select',
        'a',
        '[tabindex]',
        '[aria-label]',
        '[data-testid]',
        '[data-terminal-id]',
      ].join(','),
    ),
  )
    .filter(isVisible)
    .slice(0, 600)
    .map(describeElement);

  return {
    title: document.title,
    location: window.location.href,
    activeElement: activeElement(),
    nodes,
  };
}

function terminalDebugApi(): TerminalDebugApi | null {
  const debug = (
    window as unknown as {
      __REVERIE_TERMINAL_DEBUG__?: TerminalDebugApi | (() => unknown);
    }
  ).__REVERIE_TERMINAL_DEBUG__;
  if (!debug || typeof debug === 'function') return null;
  return debug;
}

function click(locator: AgentLocator) {
  const element = resolveElement(locator);
  if (!element) throw new Error('click target not found');
  element.scrollIntoView({ block: 'center', inline: 'center' });
  element.focus?.({ preventScroll: true });
  const rect = element.getBoundingClientRect();
  const clientX = locator.x ?? rect.left + rect.width / 2;
  const clientY = locator.y ?? rect.top + rect.height / 2;
  const init = { bubbles: true, cancelable: true, clientX, clientY, button: 0 };
  element.dispatchEvent(new PointerEvent('pointerover', init));
  element.dispatchEvent(new MouseEvent('mouseover', init));
  element.dispatchEvent(new PointerEvent('pointerdown', init));
  element.dispatchEvent(new MouseEvent('mousedown', init));
  element.dispatchEvent(new PointerEvent('pointerup', init));
  element.dispatchEvent(new MouseEvent('mouseup', init));
  element.click();
  return { clicked: true, element: describeElement(element) };
}

function typeText(request: AgentTypeRequest) {
  const element = resolveElement({ selector: request.selector ?? null }) ?? document.activeElement;
  if (!element) throw new Error('type target not found');
  if (!(element instanceof HTMLElement)) throw new Error('type target is not an element');
  element.focus({ preventScroll: true });

  if (isTextInput(element)) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? element.value.length;
    element.value = `${element.value.slice(0, start)}${request.text}${element.value.slice(end)}`;
    const caret = start + request.text.length;
    element.setSelectionRange(caret, caret);
    element.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: request.text }),
    );
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (element.isContentEditable) {
    document.execCommand('insertText', false, request.text);
    element.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: request.text }),
    );
  } else {
    element.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: request.text,
      }),
    );
    element.textContent = `${element.textContent ?? ''}${request.text}`;
    element.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: request.text }),
    );
  }

  if (request.submit) {
    const init = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' };
    element.dispatchEvent(new KeyboardEvent('keydown', init));
    element.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  return { typed: true, element: describeElement(element) };
}

function resolveElement(locator: AgentLocator): HTMLElement | null {
  if (typeof locator.x === 'number' && typeof locator.y === 'number') {
    return document.elementFromPoint(locator.x, locator.y) as HTMLElement | null;
  }
  if (locator.selector) {
    if (locator.selector.startsWith('text=')) {
      return findByText(locator.selector.slice('text='.length), false);
    }
    if (locator.selector.startsWith('partial_text=')) {
      return findByText(locator.selector.slice('partial_text='.length), true);
    }
    if (locator.selector.startsWith('css=')) {
      return document.querySelector<HTMLElement>(locator.selector.slice('css='.length));
    }
    return document.querySelector<HTMLElement>(locator.selector);
  }
  if (locator.text) return findByText(locator.text, false);
  if (locator.partialText) return findByText(locator.partialText, true);
  return null;
}

function findByText(text: string, partial: boolean) {
  const needle = normalizeText(text);
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('button, [role], a, input, textarea, [tabindex]'),
  ).filter(isVisible);
  return (
    candidates.find(element => {
      const content = normalizeText(
        element.getAttribute('aria-label') ||
          ('value' in element ? String(element.value) : '') ||
          element.innerText ||
          element.textContent ||
          '',
      );
      return partial ? content.includes(needle) : content === needle;
    }) ?? null
  );
}

function describeElement(element: Element) {
  const rect = element.getBoundingClientRect();
  const html = element as HTMLElement;
  return {
    selector: stableSelector(element),
    tag: element.tagName.toLowerCase(),
    id: element.id || null,
    role: element.getAttribute('role'),
    testId: element.getAttribute('data-testid'),
    terminalId: element.getAttribute('data-terminal-id'),
    ariaLabel: element.getAttribute('aria-label'),
    title: element.getAttribute('title'),
    text: elementText(element).slice(0, 500),
    disabled:
      'disabled' in html
        ? Boolean((html as HTMLButtonElement | HTMLInputElement).disabled)
        : element.getAttribute('aria-disabled') === 'true',
    rect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
  };
}

function stableSelector(element: Element): string {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const testId = element.getAttribute('data-testid');
  if (testId) return `[data-testid="${cssAttr(testId)}"]`;
  const terminalId = element.getAttribute('data-terminal-id');
  if (terminalId) return `[data-terminal-id="${cssAttr(terminalId)}"]`;
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) return `${element.tagName.toLowerCase()}[aria-label="${cssAttr(ariaLabel)}"]`;

  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body && parts.length < 5) {
    const currentElement: Element = current;
    const tag = currentElement.tagName.toLowerCase();
    const parent: Element | null = currentElement.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const currentTag = currentElement.tagName;
    const siblings = Array.from(parent.children).filter(child => child.tagName === currentTag);
    const index = siblings.indexOf(currentElement) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
    current = parent;
  }
  return parts.join(' > ');
}

function cssAttr(value: string) {
  return CSS.escape(value).replace(/"/g, '\\"');
}

function elementText(element: Element) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value.trim();
  }
  return (
    element.getAttribute('aria-label') ||
    (element as HTMLElement).innerText ||
    element.textContent ||
    ''
  )
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeText(text: string) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function isVisible(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

function isTextInput(element: HTMLElement): element is HTMLInputElement | HTMLTextAreaElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}
