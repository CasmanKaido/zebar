
const DLMM_Module = require("@meteora-ag/dlmm");
const DLMM = DLMM_Module.default || DLMM_Module;

console.log("Keys in Module:", Object.keys(DLMM_Module));
if (DLMM_Module.IDL) console.log("Module.IDL found");
if (DLMM.IDL) console.log("Class.IDL found");

try {
    const idl = DLMM_Module.IDL || DLMM.IDL;
    if (idl && idl.errors) {
        console.log("ERRORS found:");
        console.log(JSON.stringify(idl.errors));
    } else {
        console.log("No errors found in IDL object");
    }
} catch (e) {
    console.log(e);
}
