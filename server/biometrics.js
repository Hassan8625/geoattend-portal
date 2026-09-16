/**
 * Server-Side Biometric Verification Engine
 * Validates 128-dimensional facial embedding vectors and computes Euclidean distance.
 */

const MATCH_DISTANCE_THRESHOLD = 0.58;

/**
 * Validate that input is a valid 128-float facial descriptor
 */
function isValidDescriptor(descriptor) {
  if (!descriptor || !Array.isArray(descriptor)) return false;
  if (descriptor.length !== 128) return false;
  return descriptor.every(n => typeof n === 'number' && !isNaN(n) && isFinite(n));
}

/**
 * Compute Euclidean distance between two 128-float vectors
 */
function computeEuclideanDistance(vec1, vec2) {
  if (!isValidDescriptor(vec1) || !isValidDescriptor(vec2)) {
    return 1.0;
  }
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    const diff = vec1[i] - vec2[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Match a live descriptor against an enrolled template
 * @param {Array<number>} liveDescriptor
 * @param {Array<number>} enrolledDescriptor
 * @param {number} threshold
 * @returns {{ isMatch: boolean, distance: number, confidence: number }}
 */
function matchDescriptors(liveDescriptor, enrolledDescriptor, threshold = MATCH_DISTANCE_THRESHOLD) {
  const distance = computeEuclideanDistance(liveDescriptor, enrolledDescriptor);
  const isMatch = distance <= threshold;

  // Real linear similarity conversion (distance 0 -> 100%, distance >= 0.85 -> 0%)
  const confidence = Math.max(0, Math.min(99.9, parseFloat((Math.max(0, 1.0 - (distance / 0.85)) * 100).toFixed(1))));

  return {
    isMatch,
    distance: parseFloat(distance.toFixed(3)),
    confidence
  };
}

module.exports = {
  MATCH_DISTANCE_THRESHOLD,
  isValidDescriptor,
  computeEuclideanDistance,
  matchDescriptors
};
