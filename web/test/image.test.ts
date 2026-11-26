import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { fitImages, fitSize, MAX_IMAGE_BYTES, type ImageAttachment } from '../src/image.ts';

describe('image attachments', () => {
  it('scales to 1568 px on the long side and about 1.15 megapixels, never up', () => {
    assert.deepEqual(fitSize(4032, 3024), { w: 1238, h: 929 }); // a phone photo: the pixel cap
    assert.deepEqual(fitSize(3000, 300), { w: 1568, h: 157 }); // a long strip: the side cap
    assert.deepEqual(fitSize(800, 600), { w: 800, h: 600 });
    assert.deepEqual(fitSize(100000, 1), { w: 1568, h: 1 });
  });

  it('keeps to 4 images and 1 MiB in all, in order', () => {
    const of = (bytes: number): ImageAttachment => ({ mediaType: 'image/jpeg', data: 'A'.repeat((bytes / 3) * 4) });
    const small = Array.from({ length: 5 }, () => of(3));
    assert.equal(fitImages([], small).length, 4);
    const half = of(MAX_IMAGE_BYTES / 2 - 1);
    assert.deepEqual(fitImages([half], [of(MAX_IMAGE_BYTES), half, small[0]]), [half, half, small[0]]);
  });
});
