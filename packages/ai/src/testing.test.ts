import { describe, expect, it } from 'vitest';
import { bagOfWordsVector, fakeEmbeddingsServer, fakeVector } from './testing.js';

const cosine = (a: readonly number[], b: readonly number[]): number => {
  const dot = a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
  const norm = (vector: readonly number[]) =>
    Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return dot / (norm(a) * norm(b));
};

describe('bagOfWordsVector', () => {
  it('is the same for the same text and closer for texts that share words', () => {
    const delivery = bagOfWordsVector('Standard delivery takes 3 to 5 business days', 64);
    expect(bagOfWordsVector('Standard delivery takes 3 to 5 business days', 64)).toEqual(delivery);
    const question = bagOfWordsVector('How long does standard delivery take?', 64);
    const battery = bagOfWordsVector('Keep the battery between 20% and 80%', 64);
    expect(cosine(question, delivery)).toBeGreaterThan(cosine(question, battery));
  });

  it('reads Arabic words', () => {
    const article = bagOfWordsVector('يستغرق التوصيل العادي من 3 إلى 5 أيام عمل', 64);
    const same = bagOfWordsVector('كم يستغرق التوصيل العادي؟', 64);
    const other = bagOfWordsVector('ما رمز الإقران للتطبيق؟', 64);
    expect(cosine(same, article)).toBeGreaterThan(cosine(other, article));
  });
});

describe('fakeEmbeddingsServer', () => {
  it('answers with the vector function it was given', async () => {
    const server = fakeEmbeddingsServer(8, ['m'], bagOfWordsVector);
    const response = await server.http('https://embeddings.example/v1/embeddings', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', input: ['one two'] }),
    });
    const { data } = JSON.parse(response.body) as { data: { embedding: number[] }[] };
    expect(data[0]?.embedding).toEqual(bagOfWordsVector('one two', 8));
    expect(data[0]?.embedding).not.toEqual(fakeVector('one two', 8));
  });
});
