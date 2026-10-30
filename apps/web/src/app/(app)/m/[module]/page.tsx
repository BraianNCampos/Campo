import { MODULE_IDS } from '@campo/shared';
import { ModuleRoute } from '@/components/modules/ModuleRoute';

export function generateStaticParams() {
  return MODULE_IDS.map((module) => ({ module }));
}

export default async function Page({ params }: { params: Promise<{ module: string }> }) {
  const { module } = await params;
  return <ModuleRoute module={module} />;
}
