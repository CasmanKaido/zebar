
const DLMM_Module = require("@meteora-ag/dlmm");
const DLMM = DLMM_Module.default || DLMM_Module;

if (DLMM.createCustomizablePermissionlessLbPair2 || DLMM_Module.createCustomizablePermissionlessLbPair2) {
    console.log("V2 EXISTS");
} else {
    console.log("V2 DOES NOT EXIST");
}
