export const normalizeList = (res) => {
  if (Array.isArray(res)) return res;
  if (res?.data && Array.isArray(res.data)) return res.data;
  if (res?.results && Array.isArray(res.results)) return res.results;
  return [];
};

export const fetchWatchlist = async (authFetch) => {
  const res = await authFetch("/api/watchlist/");
  return normalizeList(res);
};

export const WATCHLIST_CHANGED_EVENT = "watchlist:changed";

export const notifyWatchlistChanged = (detail = {}) => {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(WATCHLIST_CHANGED_EVENT, {
      detail,
    })
  );
};

export const addToWatchlist = async (authFetch, coin_id, meta) => {
  return await authFetch("/api/watchlist/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(meta ? { coin_id, meta } : { coin_id }),
  });
};

export const removeFromWatchlist = async (authFetch, id) => {
  await authFetch(`/api/watchlist/${id}/`, { method: "DELETE" });
};
