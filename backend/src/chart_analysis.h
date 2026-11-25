#pragma once

#include <string>
#include <vector>

#include "json.h"
#include "matrix_store.h"

namespace dc {

struct ChartAnalysisResult {
  std::vector<Column> summary;
  std::vector<Column> series;
  std::string errorCode;
  Json errorParams = Json::object();
};

ChartAnalysisResult evaluateChartAnalysis(const std::vector<double>* x,
                                           const std::vector<double>& y,
                                           const Json& params);

}  // namespace dc
