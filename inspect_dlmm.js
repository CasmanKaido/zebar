
const DLMM_Module = require("@meteora-ag/dlmm");
const DLMM = DLMM_Module.default || DLMM_Module;

if (DLMM.createPermissionlessLbPair) {
    console.log("createPermissionlessLbPair EXISTS");
    console.log(DLMM.createPermissionlessLbPair.toString().substring(0, 500));
} else {
    console.log("createPermissionlessLbPair DOES NOT EXIST");
}
