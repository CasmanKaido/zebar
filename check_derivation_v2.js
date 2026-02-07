
const DLMM_Module = require("@meteora-ag/dlmm");
const DLMM = DLMM_Module.default || DLMM_Module;

if (DLMM.deriveCustomizablePermissionlessLbPair2 || DLMM_Module.deriveCustomizablePermissionlessLbPair2) {
    console.log("DERIVE V2 EXISTS");
} else {
    console.log("DERIVE V2 DOES NOT EXIST");
}
