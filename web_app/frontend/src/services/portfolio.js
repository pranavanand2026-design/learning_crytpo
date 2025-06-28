const unwrap = (res) => (res?.data ? res.data : res);

export const fetchPortfolio = async (authFetch) => {
  const res = await authFetch("/api/portfolio/");
  return unwrap(res);
};

export const buyHolding = async (authFetch, payload) => {
  const res = await authFetch("/api/portfolio/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return unwrap(res);
};

export const sellHolding = async (authFetch, payload) => {
  const res = await authFetch("/api/portfolio/sell/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return unwrap(res);
};

export const clearPortfolio = async (authFetch) => {
  const res = await authFetch("/api/portfolio/", { method: "DELETE" });
  return unwrap(res);
};

