import {initializeApp} from "firebase-admin/app";
import {setGlobalOptions} from "firebase-functions/v2";

initializeApp();
setGlobalOptions({maxInstances: 10});

export {createHuubReplayChallenge, getHuubReplayChallengeStatus} from "./replayBridge";
