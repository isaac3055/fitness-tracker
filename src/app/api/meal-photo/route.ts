import { handleMealPhoto, productionDependencies } from "../../../lib/meal-photo-handler";
export const runtime="nodejs";
export const maxDuration=150;
export async function POST(request:Request) {
 return handleMealPhoto(request,productionDependencies());
}
