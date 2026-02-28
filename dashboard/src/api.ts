let token = localStorage.getItem("dashboard_token") || "";

type ApiOptions = {
  method?: string;
  body?: unknown;
};

export function setToken(t) {
  token = t;
  localStorage.setItem("dashboard_token", t);
}

export function getToken() {
  return token;
}

export async function api(url: string, options: ApiOptions = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(token ? { "x-dashboard-token": token } : {})
  };

  const res = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }

  return res.json();
}
