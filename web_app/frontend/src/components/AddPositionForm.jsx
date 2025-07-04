// web_app/frontend/src/components/AddPositionForm.jsx
import { useEffect, useMemo, useState } from "react";
import { addPosition } from "../services/simulations";
import { getCoinSuggestions } from "../services/coins"; // <- single import

// small debounce hook
function useDebounced(value, delay = 250) {
    const [v, setV] = useState(value);
    useEffect(() => {
        const id = setTimeout(() => setV(value), delay);
        return () => clearTimeout(id);
    }, [value, delay]);
    return v;
}

export default function AddPositionForm({
    sims = [],
    currentSimId = "",
    onAdded = () => {},
}) {
    const [simId, setSimId] = useState(currentSimId || "");
    const [units, setUnits] = useState("");
    const [startTime, setStartTime] = useState("");
    const [endTime, setEndTime] = useState("");
    const [error, setError] = useState("");
    const [touchedUnits, setTouchedUnits] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    function toLocalInput(dt) {
        const d = new Date(dt);
        const pad = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    const nowIsoLocal = toLocalInput(new Date());
    const currentSim = useMemo(() => sims.find(s => s.id === simId) || null, [sims, simId]);
    const simStartLocal = useMemo(() => {
        if (!currentSim?.start_date) return "";
        try { return new Date(currentSim.start_date).toISOString().slice(0,16); } catch { return ""; }
    }, [currentSim]);

    // coin search/dropdown state
    const [coinQuery, setCoinQuery] = useState("");
    const debouncedQuery = useDebounced(coinQuery, 250);
    const [options, setOptions] = useState([]);
    const [selectedCoin, setSelectedCoin] = useState(null);

    // load initial options and search
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const list = await getCoinSuggestions(debouncedQuery);
            if (!cancelled) setOptions(list || []);
        })();
        return () => {
            cancelled = true;
        };
    }, [debouncedQuery]);

    // when external currentSimId changes
    useEffect(() => {
        if (currentSimId) setSimId(currentSimId);
    }, [currentSimId]);

    const dateInvalid = useMemo(() => {
        if (endTime && endTime > nowIsoLocal) return true;
        if (simStartLocal && startTime && startTime < simStartLocal) return true;
        if (startTime && endTime && endTime < startTime) return true;
        return false;
    }, [startTime, endTime, nowIsoLocal, simStartLocal]);

    const unitsInvalid = useMemo(() => {
        if (units === "") return false; // don't flag empty as invalid
        const n = Number(units);
        return !Number.isFinite(n) || n <= 0;
    }, [units]);
    const canSubmit = useMemo(
        () => !!simId && !!selectedCoin?.id && units !== "" && !unitsInvalid && !dateInvalid,
        [simId, selectedCoin, units, unitsInvalid, dateInvalid]
    );
    // Enable button when core fields are present so a click can reveal errors
    const buttonEnabled = useMemo(
        () => !!simId && !!selectedCoin?.id && !dateInvalid,
        [simId, selectedCoin, dateInvalid]
    );
    // Only show units error once user has interacted (non-empty + blurred)
    // or after they attempt to submit
    const showUnitsError = (submitted || touchedUnits) && units !== "" && unitsInvalid;

    const handleSubmit = async (e) => {
        e.preventDefault();
        // Mark that user attempted to submit to reveal validation messages
        setSubmitted(true);
        if (!canSubmit) return;
        const payload = {
            coin_id: selectedCoin.id, // ensure we send the CoinGecko id
            units,
        };
        if (startTime) payload.start_time = new Date(startTime).toISOString();
        if (endTime) payload.end_time = new Date(endTime).toISOString();

        try {
            setError("");
            await addPosition(simId, payload);
            setUnits("");
            setStartTime("");
            setEndTime("");
            setCoinQuery("");
            setSelectedCoin(null);
            onAdded();
        } catch (e) {
            const msg = e?.response?.data?.detail || e?.message || "Failed to add position";
            setError(typeof msg === "string" ? msg : JSON.stringify(msg));
        }
    };

    return (
        <div className="card bg-base-100 shadow">
            <div className="card-body gap-4">
                <h2 className="card-title">Add Position</h2>

                {!!error && (
                    <div className="alert alert-error"><span>{error}</span></div>
                )}
                <div className="grid gap-4 md:grid-cols-2">
                    {/* Simulation */}
                    <label className="form-control">
                        <div className="label"><span className="label-text">Simulation</span></div>
                        <select
                            className="select select-bordered"
                            value={simId}
                            onChange={(e) => setSimId(e.target.value)}
                        >
                            <option value="">Select simulation</option>
                            {sims.map((s) => (
                                <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                        </select>
                    </label>

                    {/* Coin searchable dropdown */}
                    <label className="form-control">
                        <div className="label"><span className="label-text">Coin</span></div>
                        <div className="dropdown dropdown-end w-full">
                            <label tabIndex={0} className="input input-bordered flex items-center justify-between gap-2 w-full">
                                <input
                                    className="grow bg-transparent outline-none"
                                    placeholder={selectedCoin ? `${selectedCoin.name} (${selectedCoin.symbol?.toUpperCase?.() ?? ""})` : "Search coin..."}
                                    value={coinQuery}
                                    onChange={(e) => {
                                        setCoinQuery(e.target.value);
                                        setSelectedCoin(null);
                                    }}
                                />
                                <svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M7 10l5 5 5-5z" /></svg>
                            </label>

                            <ul tabIndex={0} className="dropdown-content menu p-2 shadow bg-base-100 rounded-box w-full mt-2 max-h-60 overflow-auto">
                                {options.length === 0 && (
                                    <li className="px-3 py-2 text-sm text-base-content/70">No results</li>
                                )}
                                {options.map((c) => (
                                    <li key={c.id}>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setSelectedCoin(c);
                                                setCoinQuery(`${c.name} (${(c.symbol || "").toUpperCase()})`);
                                            }}
                                        >
                                            {c.name} <span className="opacity-70">({(c.symbol || "").toUpperCase()})</span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </label>

                    {/* Units */}
                    <label className="form-control">
                        <div className="label"><span className="label-text">Units</span></div>
                        <input
                            type="number"
                            step="any"
                            min="0.00000001"
                            className="input input-bordered"
                            value={units}
                            onChange={(e) => setUnits(e.target.value)}
                            onBlur={() => setTouchedUnits(true)}
                            placeholder="e.g. 1.5"
                        />
                    </label>
                    {showUnitsError && (
                        <div className="text-error text-sm">Units must be a positive number.</div>
                    )}

                    {/* Start time */}
                    <label className="form-control">
                        <div className="label"><span className="label-text">Start time</span></div>
                        <input
                            type="datetime-local"
                            className="input input-bordered"
                            min={simStartLocal || undefined}
                            max={nowIsoLocal}
                            value={startTime}
                            onChange={(e) => setStartTime(e.target.value)}
                        />
                    </label>

                    {/* End time */}
                    <label className="form-control md:col-span-2">
                        <div className="label"><span className="label-text">End time (optional)</span></div>
                        <input
                            type="datetime-local"
                            className="input input-bordered"
                            max={nowIsoLocal}
                            value={endTime}
                            onChange={(e) => setEndTime(e.target.value)}
                        />
                    </label>
                {dateInvalid && (
                    <div className="text-error text-sm">Check dates: start must be on/after simulation start; end cannot be in the future; end must be after start.</div>
                )}
                </div>

                <button className="btn btn-primary w-fit" disabled={!buttonEnabled} onClick={handleSubmit}>
                    Add
                </button>
            </div>
        </div>
    );
}
