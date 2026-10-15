import {normalizeAdjustments} from './image-engine.mjs';

const geometry=['rotation','cropRatio','cropX','cropY','flipHorizontal','perspectiveHorizontal','perspectiveVertical'];
export const LOCAL_PORTRAIT_CONTROLS=Object.freeze(['skinSmoothing','faceLight','teethWhitening','eyeBrightness','blemishReduction','skinEvenness','underEyeLight','eyeContrast','lipSaturation']);

/** Semantic safeguards live outside the model. A valid JSON schema does not
 * establish that a face exists or authorize changing a photographer's framing. */
export function protectLocalRecommendation(result,{currentAdjustments={},facesDetected=false}={}){
  const current=normalizeAdjustments(currentAdjustments);
  const adjustments={...result.adjustments};
  for(const key of geometry)adjustments[key]=current[key];
  if(!facesDetected)for(const key of LOCAL_PORTRAIT_CONTROLS)adjustments[key]=0;
  return {...result,adjustments,constraints:{...result.constraints,geometryPreserved:true,portraitDisabled:!facesDetected}};
}
