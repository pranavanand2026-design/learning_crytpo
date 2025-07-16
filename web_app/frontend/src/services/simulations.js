import axios from "axios";

const API_URL = "http://localhost:8000/api";

const api = axios.create({
    baseURL: API_URL,
    withCredentials: true,
    headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
    },
    // axios' xsrf auto-header only works same-origin; we'll set it manually
    xsrfCookieName: "csrftoken",
    xsrfHeaderName: "X-CSRFToken",
});

function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(";").shift();
    return null;
}

async function ensureCsrfHeader() {
    // ensure cookie exists
    await api.get("/csrf/");
    // read cookie and set default header for subsequent requests
    const token = getCookie("csrftoken");
    if (token) {
        api.defaults.headers["X-CSRFToken"] = token;
    }
    return token;
}

export async function listSimulations() {
    const { data } = await api.get("/simulations/");
    return data;
}

export async function createSimulation(payload) {
    const token = await ensureCsrfHeader();
    const { data } = await api.post("/simulations/", payload, {
        headers: token ? { "X-CSRFToken": token } : {},
    });
    return data;
}

export async function getSimulation(simId) {
    const { data } = await api.get(`/simulations/${simId}/`);
    return data;
}

export async function deleteSimulation(simId) {
    const token = await ensureCsrfHeader();
    const { data } = await api.delete(`/simulations/${simId}/`, {
        headers: token ? { "X-CSRFToken": token } : {},
    });
    return data;
}

export async function addPosition(simId, payload) {
    const token = await ensureCsrfHeader();
    const body = {
        coin_id: payload.coin_id,
        type: "BUY",
        quantity: payload.units,
        simulation: simId,
    };
    if (payload.start_time) body.time = payload.start_time;
    const { data } = await api.post(`/simulations/${simId}/transactions/`, body, {
        headers: token ? { "X-CSRFToken": token } : {},
    });
    return data;
}

export async function deleteTransaction(txId) {
    const token = await ensureCsrfHeader();
    const { data } = await api.delete(`/transactions/${txId}/`, {
        headers: token ? { "X-CSRFToken": token } : {},
    });
    return data;
}
