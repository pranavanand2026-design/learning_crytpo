import React from "react";
import SearchIcon from "@mui/icons-material/Search";
import { Link } from "react-router-dom";

/**
 * Presentational Watchlist table.
 * Expects parent to provide already-filtered/sorted/paged `rows`.
 *
 * Props:
 *  - rows: Array<{ id, symbol, name, image, current_price, market_cap, price_change_percentage_24h }>
 *  - watchedIds: string[] | Set<string>
 *  - onToggleWatch: (id: string, next: boolean) => void
 *  - query: string
 *  - onQueryChange: (q: string) => void
 *  - sortKey: 'change' | 'market_cap' | 'price'
 *  - sortDir: 'asc' | 'desc'
 *  - onSortChange: (key, dir) => void
 *  - page: number (1-based)
 *  - pageSize: number
 *  - onPageChange: (nextPage: number) => void
 *  - loading: boolean
 *  - error: string | null
 *  - lastUpdated: Date | number | null
 */

const currencyFormatter = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 2,
});

const numberCompact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});

function isWatchedFn(watchedIds, id) {
  if (!watchedIds) return false;
  if (Array.isArray(watchedIds)) return watchedIds.includes(id);
  if (watchedIds instanceof Set) return watchedIds.has(id);
  return false;
}

function timeAgoLabel(lastUpdated) {
  if (!lastUpdated) return null;
  const ts = typeof lastUpdated === "number" ? lastUpdated : lastUpdated.getTime();
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins <= 0) return "just now";
  if (mins === 1) return "1 minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

export default function WatchlistTable({
  rows = [],
  watchedIds = [],
  onToggleWatch = () => {},
  query = "",
  onQueryChange = () => {},
  sortKey = "change",
  sortDir = "desc",
  onSortChange = () => {},
  page = 1,
  pageSize = 10,
  onPageChange = () => {},
  loading = false,
  error = null,
  lastUpdated = null,
}) {
  const lastUpdatedLabel = timeAgoLabel(lastUpdated);

  function handleSortSelect(e) {
    const value = e.target.value; // e.g. "change_desc"
    const [key, dir] = value.split("_");
    onSortChange(key, dir);
  }

  const sortValue = `${sortKey}_${sortDir}`; // keep select controlled

  return (
    <div className="rounded-box bg-base-100 p-6 shadow">
      {/* Header / Controls */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Watchlist</h2>
          <p className="text-sm text-base-content/70">
            {lastUpdatedLabel ? `Last refreshed ${lastUpdatedLabel}` : "Live market snapshot"}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <label className="input input-bordered input-sm flex items-center gap-2">
            <SearchIcon fontSize="small" className="text-base-content/70" />
            <input
              type="text"
              placeholder="Find a coin"
              aria-label="Search watchlist"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
            />
          </label>

          {/* Sort */}
          <select
            className="select select-bordered select-sm"
            aria-label="Sort watchlist"
            value={sortValue}
            onChange={handleSortSelect}
          >
            <option value="change_desc">Change (24h): High → Low</option>
            <option value="change_asc">Change (24h): Low → High</option>
            <option value="market_cap_desc">Market cap: High → Low</option>
            <option value="market_cap_asc">Market cap: Low → High</option>
            <option value="price_desc">Price: High → Low</option>
            <option value="price_asc">Price: Low → High</option>
          </select>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="alert alert-error mt-4">
          <span>{error}</span>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="mt-4 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Last price</th>
                <th>24h change</th>
                <th>24h high / low</th>
                <th>Market cap</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: Math.min(pageSize, 8) }).map((_, i) => (
                <tr key={`skeleton-${i}`} className="animate-pulse">
                  <td>
                    <div className="flex items-center gap-2">
                      <div className="avatar">
                        <div className="w-10 rounded-full bg-base-200" />
                      </div>
                      <div>
                        <div className="h-3 w-28 rounded bg-base-200" />
                        <div className="mt-1 h-3 w-16 rounded bg-base-200" />
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="h-3 w-20 rounded bg-base-200" />
                  </td>
                  <td>
                    <div className="h-5 w-24 rounded bg-base-200" />
                  </td>
                  <td>
                    <div className="h-3 w-24 rounded bg-base-200" />
                    <div className="mt-1 h-3 w-20 rounded bg-base-200" />
                  </td>
                  <td>
                    <div className="h-3 w-24 rounded bg-base-200" />
                  </td>
                  <td>
                    <div className="h-6 w-16 rounded bg-base-200" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && rows.length === 0 && (
        <div className="mt-6 rounded-box border border-dashed border-base-content/20 p-8 text-center">
          <p className="text-base-content/70">
            No coins to show. Try adjusting your search or add coins to your watchlist.
          </p>
        </div>
      )}

      {/* Table */}
      {!loading && !error && rows.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Last price</th>
                <th>24h change</th>
                <th>24h high / low</th>
                <th>Market cap</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((coin) => {
                const isWatched = isWatchedFn(watchedIds, coin.id);
                const change = coin.price_change_percentage_24h;
                const changeBadge =
                  change == null
                    ? "badge-ghost"
                    : change >= 0
                    ? "badge-success"
                    : "badge-error";
                const changeLabel =
                  change == null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;

                // Optional: high/low not in your current service mapping yet.
                // You can inject them later; for now we derive from price +/- a tiny % to avoid blank.
                const high24h = coin.high_24h ?? coin.current_price * 1.01;
                const low24h = coin.low_24h ?? coin.current_price * 0.99;

                return (
                  <tr key={coin.id}>
                    <td>
                      <Link to={`/coin/${coin.id}`} className="flex items-center gap-2 hover:opacity-80">
                        <div className="avatar">
                          <div className="w-10 rounded-full ring ring-base-200">
                            {coin.image ? (
                              <img src={coin.image} alt={coin.name} />
                            ) : (
                              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                                <span className="text-sm font-semibold">
                                  {(coin.symbol || "").toUpperCase()}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                        <div>
                          <div className="font-semibold">{coin.name}</div>
                          <div className="text-xs uppercase text-base-content/70">
                            {(coin.symbol || "").toUpperCase()}
                          </div>
                        </div>
                      </Link>
                    </td>
                    <td className="font-mono text-sm">
                      {currencyFormatter.format(coin.current_price ?? 0)}
                    </td>

                    <td>
                      <span className={`badge ${changeBadge}`}>{changeLabel}</span>
                    </td>

                    <td className="font-mono text-xs">
                      <div>{currencyFormatter.format(high24h)}</div>
                      <div className="text-base-content/70">
                        {currencyFormatter.format(low24h)}
                      </div>
                    </td>

                    <td className="text-sm text-base-content/70">
                      ${numberCompact.format(coin.market_cap ?? 0)}
                    </td>

                    <td>
                      {isWatched ? (
                        <button
                          className="btn btn-ghost btn-xs text-error"
                          onClick={() => onToggleWatch(coin.id, false)}
                        >
                          Remove
                        </button>
                      ) : (
                        <button
                          className="btn btn-ghost btn-xs text-primary"
                          onClick={() => onToggleWatch(coin.id, true)}
                        >
                          Add
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Pagination */}
          <div className="mt-4 flex items-center justify-between">
            <div className="text-sm text-base-content/70">
              Page <span className="font-medium">{page}</span>, showing up to{" "}
              <span className="font-medium">{pageSize}</span> rows
            </div>
            <div className="join">
              <button
                className="btn btn-sm join-item"
                onClick={() => onPageChange(Math.max(1, page - 1))}
                disabled={page <= 1}
              >
                Previous
              </button>
              <button
                className="btn btn-sm join-item"
                onClick={() => onPageChange(page + 1)}
                disabled={rows.length < pageSize}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}