
export const TRADINGVIEW_COOKIES = {
    __eoi: "ID=28f9a975a18185be:T=1770157793:RT=1770157793:S=AA-AfjZCkeY98mvbBJryqmxS4L-G",
    "_sp_id.cf1a": ".1769464623.1.1771025170..3d8da15c-0d4a-45b4-83d4-4aa28384b422..527fb432-1bd0-49a1-b80b-7bfab814bbe9.1769464624395.26",
    "_sp_ses.cf1a": "*",
    cachec: "5f98ac9a-cd0a-4198-bbde-e643744083fc",
    cookiePrivacyPreferenceBannerProduction: "ignored",
    device_t: "MDQ2N0J3OjA.JXVjSY6qcyTzNumI9qHDD3OcCnepyIaG3KbmPmE0Cy4",
    etg: "5f98ac9a-cd0a-4198-bbde-e643744083fc",
    g_state: '{"i_l":0,"i_ll":1771024887528,"i_e":{"enable_itp_optimization":13}}',
    png: "5f98ac9a-cd0a-4198-bbde-e643744083fc",
    sessionid: "owdl1knxegxizb3jz4jub973l3jf8r5h",
    sessionid_sign: "v3:vTg6tTsF73zJMZdotbHAjbi4gIaUtfLj8zpEbrnhJHQ=",
    sp: "e2aed857-2c85-41e3-b7c2-1f8288c0b3aa",
    tv_ecuid: "5f98ac9a-cd0a-4198-bbde-e643744083fc"
};


export function getCookieString() {
    return Object.entries(TRADINGVIEW_COOKIES)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');
}
