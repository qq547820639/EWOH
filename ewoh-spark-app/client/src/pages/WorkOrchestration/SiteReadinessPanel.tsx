import { useQuery } from '@tanstack/react-query';
import QueryState from '../../components/QueryState';
import { queryKeys } from '../../hooks/queryKeys';
import { QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';
import { getWorkSiteReadiness } from '../../api/work';
import SiteReadinessWizard from './SiteReadinessWizard';

const SiteReadinessPanel = (): React.ReactElement => {
  const siteReadinessQuery = useQuery({
    queryKey: queryKeys.workSiteReadiness,
    queryFn: getWorkSiteReadiness,
    staleTime: QUERY_STALE_TIME_MS,
  });

  return (
    <QueryState
      isLoading={siteReadinessQuery.isLoading}
      isFetching={siteReadinessQuery.isFetching}
      isError={siteReadinessQuery.isError}
      isStale={siteReadinessQuery.isStale}
      isEmpty={!siteReadinessQuery.data}
      onRefresh={() => siteReadinessQuery.refetch()}
      errorMessage={
        siteReadinessQuery.error instanceof Error
          ? siteReadinessQuery.error.message
          : '场地就绪数据加载失败'
      }
      loadingMessage="正在读取场地就绪报告"
      updatedAt={siteReadinessQuery.dataUpdatedAt}
    >
      <SiteReadinessWizard reports={siteReadinessQuery.data ?? []} />
    </QueryState>
  );
};

export default SiteReadinessPanel;