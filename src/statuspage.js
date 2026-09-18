import { config, statuspageEnabled } from './config.js';

const API_BASE = 'https://api.statuspage.io/v1';

async function request(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: {
            authorization: `OAuth ${config.statuspage.apiKey}`,
            'content-type': 'application/json',
            ...options.headers,
        },
        signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Statuspage ${response.status} ${response.statusText} — ${body.slice(0, 300)}`);
    }

    return response.json();
}

// Fetch the page's components so configured ids can be validated at startup.
export async function listComponents() {
    if (!statuspageEnabled) return [];
    return request(`/pages/${config.statuspage.pageId}/components`);
}

// Push a single component to a new status.
export async function setComponentStatus(componentId, status) {
    if (!statuspageEnabled) return;
    await request(`/pages/${config.statuspage.pageId}/components/${componentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ component: { status } }),
    });
}

// Warn about component ids that do not exist on the page — a typo here would
// otherwise only surface as a 404 during the first outage.
export async function verifyComponents(checks) {
    if (!statuspageEnabled) {
        console.warn('[statuspage] Not configured — status updates disabled.');
        return;
    }

    try {
        const components = await listComponents();
        const byId = new Map(components.map((component) => [component.id, component]));

        for (const check of checks) {
            if (!check.componentId) {
                console.warn(`[statuspage] "${check.name}" has no component id — alerts only.`);
                continue;
            }
            const component = byId.get(check.componentId);
            if (component) {
                console.log(`[statuspage] "${check.name}" -> component "${component.name}" (${component.status})`);
            } else {
                console.warn(`[statuspage] "${check.name}" -> unknown component id ${check.componentId}`);
            }
        }
    } catch (err) {
        console.warn(`[statuspage] Could not verify components: ${err.message}`);
    }
}
